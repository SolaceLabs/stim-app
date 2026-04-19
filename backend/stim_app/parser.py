"""Parse .stim YAML trace files into a structured, query-friendly model."""
from __future__ import annotations

import re
from dataclasses import dataclass, field, asdict
from typing import Any, Optional

import yaml

_TOPIC_AGENT_RE = re.compile(r"/(?:request|response|status)/([^/]+)")


def _walk(obj: Any, key: str):
    """Yield all values for a nested key anywhere in the object."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == key:
                yield v
            yield from _walk(v, key)
    elif isinstance(obj, list):
        for item in obj:
            yield from _walk(item, key)


def _first(obj: Any, key: str):
    for v in _walk(obj, key):
        return v
    return None


def _extract_parts(payload: dict) -> list[dict]:
    """Pull out A2A message parts from any common location in the payload."""
    candidates = [
        ("params", "message", "parts"),
        ("result", "status", "message", "parts"),
        ("result", "message", "parts"),
        ("result", "artifact", "parts"),
    ]
    for path in candidates:
        cur = payload
        ok = True
        for k in path:
            if isinstance(cur, dict) and k in cur:
                cur = cur[k]
            else:
                ok = False
                break
        if ok and isinstance(cur, list):
            return cur
    return []


@dataclass
class Event:
    index: int
    id: str
    task_id: str
    created_time: int
    t_offset_ms: int  # relative to task start
    topic: str
    direction: str  # request | response | status
    agent: Optional[str]
    kind: str  # llm_request | llm_response | tool_call | tool_result | peer_request | peer_response | status_text | other
    text: Optional[str]  # extracted text if any
    tool_name: Optional[str]
    tool_args: Optional[dict]
    tool_result_preview: Optional[str]
    tool_result_size: Optional[int]
    status_text: Optional[str]
    model: Optional[str]
    input_tokens: Optional[int]
    output_tokens: Optional[int]
    function_call_id: Optional[str]
    payload: dict  # full raw payload for inspector

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class TaskInfo:
    task_id: str
    user_id: Optional[str]
    start_time: Optional[int]
    end_time: Optional[int]
    duration_ms: Optional[int]
    status: Optional[str]
    initial_request_text: Optional[str]
    total_tasks: Optional[int]
    log_file_version: Optional[str]


@dataclass
class ParsedTrace:
    filename: str
    task: TaskInfo
    events: list[Event]
    agents: list[str]
    models: list[str]

    def to_summary(self) -> dict:
        return {
            "filename": self.filename,
            "task": asdict(self.task),
            "event_count": len(self.events),
            "agents": self.agents,
            "models": self.models,
        }


def _classify(direction: str, payload: dict, parts: list[dict]) -> str:
    # dig for 'type' field in parts data
    for part in parts:
        data = part.get("data") if isinstance(part, dict) else None
        if isinstance(data, dict):
            t = data.get("type")
            if t == "llm_request":
                return "llm_request"
            if t == "llm_response":
                return "llm_response"
            if t == "tool_invocation_start":
                return "tool_call"
            if t == "tool_invocation_end":
                return "tool_result"
            if t == "status_update":
                return "status_text"
            if t == "agent_status_message":
                return "status_text"
            if t and "tool" in t and "start" in t:
                return "tool_call"
            if t and "tool" in t and ("end" in t or "result" in t):
                return "tool_result"
    if direction == "request":
        return "peer_request"
    if direction == "response":
        return "peer_response"
    return "other"


def parse_stim(filename: str, content: str) -> ParsedTrace:
    data = yaml.safe_load(content)
    if not isinstance(data, dict):
        raise ValueError("Invalid stim file: root is not a mapping")

    inv = data.get("invocation_details", {}) or {}
    start = inv.get("start_time")
    end = inv.get("end_time")
    duration = (end - start) if (start is not None and end is not None) else None

    task = TaskInfo(
        task_id=inv.get("task_id", "unknown"),
        user_id=inv.get("user_id"),
        start_time=start,
        end_time=end,
        duration_ms=duration,
        status=inv.get("status"),
        initial_request_text=inv.get("initial_request_text"),
        total_tasks=inv.get("total_tasks"),
        log_file_version=inv.get("log_file_version"),
    )

    flow = data.get("invocation_flow", []) or []
    t0 = flow[0]["created_time"] if flow else (start or 0)

    events: list[Event] = []
    agents: set[str] = set()
    models: set[str] = set()

    for i, e in enumerate(flow):
        topic = e.get("topic", "")
        direction = e.get("direction", "")
        payload = e.get("payload", {}) or {}
        parts = _extract_parts(payload)

        # agent from topic
        m = _TOPIC_AGENT_RE.search(topic)
        agent_from_topic = m.group(1) if m else None
        agent_from_meta = _first(payload, "metadata")
        agent_name = None
        if isinstance(agent_from_meta, dict):
            agent_name = agent_from_meta.get("agent_name")
        agent = agent_name or agent_from_topic

        kind = _classify(direction, payload, parts)

        # extract text / tool info / tokens
        text = None
        tool_name = None
        tool_args = None
        tool_result_preview = None
        tool_result_size = None
        status_text = None
        model = None
        in_tok = None
        out_tok = None
        fn_id = None

        for part in parts:
            if not isinstance(part, dict):
                continue
            if isinstance(part.get("text"), str):
                text = part["text"] if text is None else text + part["text"]
            data = part.get("data")
            if isinstance(data, dict):
                tool_name = tool_name or data.get("tool_name")
                tool_args = tool_args or (data.get("tool_args") if isinstance(data.get("tool_args"), dict) else None)
                status_text = status_text or data.get("status_text")
                fn_id = fn_id or data.get("function_call_id")
                if "result_data" in data:
                    rd = data["result_data"]
                    import json as _json
                    try:
                        rds = _json.dumps(rd, default=str)
                    except Exception:
                        rds = str(rd)
                    tool_result_size = len(rds)
                    tool_result_preview = rds[:600]
                usage = data.get("usage") or data.get("llm_usage")
                if isinstance(usage, dict):
                    in_tok = in_tok or usage.get("input_tokens")
                    out_tok = out_tok or usage.get("output_tokens")
                    model = model or usage.get("model")
                req = data.get("request")
                if isinstance(req, dict):
                    model = model or req.get("model")

        if agent:
            agents.add(agent)
        if model:
            models.add(model)

        created_time = e.get("created_time", t0)
        events.append(
            Event(
                index=i,
                id=e.get("id", f"ev{i}"),
                task_id=e.get("task_id", task.task_id),
                created_time=created_time,
                t_offset_ms=created_time - t0,
                topic=topic,
                direction=direction,
                agent=agent,
                kind=kind,
                text=text,
                tool_name=tool_name,
                tool_args=tool_args,
                tool_result_preview=tool_result_preview,
                tool_result_size=tool_result_size,
                status_text=status_text,
                model=model,
                input_tokens=in_tok,
                output_tokens=out_tok,
                function_call_id=fn_id,
                payload=payload,
            )
        )

    return ParsedTrace(
        filename=filename,
        task=task,
        events=events,
        agents=sorted(agents),
        models=sorted(models),
    )


# ---------- derived analytics ----------

def compute_spans(trace: ParsedTrace) -> list[dict]:
    """Derive logical spans (LLM calls, tool executions, peer delegations) from the event stream.

    Heuristic: pair llm_request → next llm_response (same agent) and tool_call → matching tool_result
    by function_call_id. Peer requests → matching peer responses by task_id suffix.
    """
    spans: list[dict] = []
    events = trace.events

    # LLM spans: request event (usage=None) → next event with usage dict (same agent)
    # The trace shows pattern: a 'request' status event at T0, then a 'usage' event at T1 marks completion.
    open_llm: dict[str, int] = {}  # agent -> index
    for i, e in enumerate(events):
        if e.kind == "llm_request" or (e.model and e.input_tokens is None and e.kind != "tool_result"):
            key = e.agent or "?"
            if key not in open_llm:
                open_llm[key] = i
        elif e.input_tokens is not None and e.kind != "tool_result":
            key = e.agent or "?"
            if key in open_llm:
                start_idx = open_llm.pop(key)
                s = events[start_idx]
                spans.append({
                    "type": "llm",
                    "agent": key,
                    "model": e.model or s.model,
                    "start_ms": s.t_offset_ms,
                    "end_ms": e.t_offset_ms,
                    "duration_ms": e.t_offset_ms - s.t_offset_ms,
                    "input_tokens": e.input_tokens,
                    "output_tokens": e.output_tokens,
                    "start_event": start_idx,
                    "end_event": i,
                })

    # Tool spans: tool_call → tool_result with matching fn_id
    open_tools: dict[str, int] = {}
    for i, e in enumerate(events):
        if e.kind == "tool_call" and e.function_call_id:
            open_tools[e.function_call_id] = i
        elif e.kind == "tool_result" and e.function_call_id and e.function_call_id in open_tools:
            start_idx = open_tools.pop(e.function_call_id)
            s = events[start_idx]
            spans.append({
                "type": "tool",
                "agent": e.agent or s.agent,
                "tool_name": s.tool_name or e.tool_name,
                "start_ms": s.t_offset_ms,
                "end_ms": e.t_offset_ms,
                "duration_ms": e.t_offset_ms - s.t_offset_ms,
                "result_size": e.tool_result_size,
                "start_event": start_idx,
                "end_event": i,
            })

    spans.sort(key=lambda s: s["start_ms"])
    return spans


def compute_summary(trace: ParsedTrace) -> dict:
    spans = compute_spans(trace)
    total = trace.task.duration_ms or 0
    llm_time = sum(s["duration_ms"] for s in spans if s["type"] == "llm")
    tool_time = sum(s["duration_ms"] for s in spans if s["type"] == "tool")

    per_agent_tokens: dict[str, dict] = {}
    for e in trace.events:
        if e.input_tokens is None and e.output_tokens is None:
            continue
        a = e.agent or "?"
        d = per_agent_tokens.setdefault(a, {"input": 0, "output": 0, "calls": 0})
        if e.input_tokens:
            d["input"] += e.input_tokens
        if e.output_tokens:
            d["output"] += e.output_tokens
        d["calls"] += 1

    slowest = sorted(spans, key=lambda s: -s["duration_ms"])[:10]

    return {
        "total_ms": total,
        "llm_ms": llm_time,
        "tool_ms": tool_time,
        "llm_pct": round(100 * llm_time / total, 1) if total else 0,
        "tool_pct": round(100 * tool_time / total, 1) if total else 0,
        "per_agent_tokens": per_agent_tokens,
        "slowest_spans": slowest,
        "span_count": len(spans),
    }
