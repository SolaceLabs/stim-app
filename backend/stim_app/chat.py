"""LLM chat with tool use for querying a loaded stim trace.

Provider-agnostic: uses stim_app.llm to support native Anthropic or any
OpenAI-compatible endpoint (e.g. a litellm proxy).
"""
from __future__ import annotations

import json
from dataclasses import asdict
from typing import AsyncIterator

from .llm import get_provider
from .parser import ParsedTrace, compute_spans, compute_summary

SYSTEM = """You are a latency & flow diagnostic assistant for Solace Agent Mesh (SAM) agent traces.

You have tools to query a loaded .stim trace:
- get_task_info: task metadata (duration, request text, agents, models)
- get_summary: derived analytics (LLM vs tool time, per-agent tokens, slowest spans)
- get_spans: list of all LLM + tool spans with start/end/duration
- list_events: table of events (filter by agent, kind, window)
- get_event: full payload for one event by index
- search_text: regex across event text / status / tool args
- get_tool_result: full tool result data (may be large)

Prefer calling tools over guessing. When diagnosing latency, start with get_summary, then get_spans to find the slowest steps, then drill into specific events.

Report concisely. Use tables when comparing multiple spans. Always cite event indices so the user can click through.

When you identify specific events worth attention (slow spans, errors, suspicious payloads, redundant calls), call `flag_events` with those indices and a short reason. The UI will highlight them for the user. Call it as soon as you're confident, and again later if your conclusion changes — each call replaces the previous flag set for the current answer.
"""


def _tools():
    return [
        {
            "name": "get_task_info",
            "description": "Task-level metadata: id, user, request text, duration, agents, models.",
            "input_schema": {"type": "object", "properties": {}},
        },
        {
            "name": "get_summary",
            "description": "Derived analytics: total ms, LLM ms, tool ms, per-agent tokens, top 10 slowest spans.",
            "input_schema": {"type": "object", "properties": {}},
        },
        {
            "name": "get_spans",
            "description": "All logical spans (LLM calls and tool executions) with durations. Optionally filter.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": ["llm", "tool"], "description": "filter by span type"},
                    "agent": {"type": "string"},
                    "min_duration_ms": {"type": "integer"},
                },
            },
        },
        {
            "name": "list_events",
            "description": "List events with key fields (index, t_offset_ms, agent, kind, tool_name, tokens). Supports filters.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "agent": {"type": "string"},
                    "kind": {"type": "string", "description": "llm_request|llm_response|tool_call|tool_result|peer_request|peer_response|status_text"},
                    "start_ms": {"type": "integer"},
                    "end_ms": {"type": "integer"},
                    "limit": {"type": "integer", "default": 100},
                },
            },
        },
        {
            "name": "get_event",
            "description": "Full event detail (including full payload) by index.",
            "input_schema": {
                "type": "object",
                "properties": {"index": {"type": "integer"}},
                "required": ["index"],
            },
        },
        {
            "name": "search_text",
            "description": "Regex search across text, status_text, tool_name, and tool_args of events.",
            "input_schema": {
                "type": "object",
                "properties": {"pattern": {"type": "string"}, "limit": {"type": "integer", "default": 20}},
                "required": ["pattern"],
            },
        },
        {
            "name": "flag_events",
            "description": "Mark events as noteworthy so the UI can highlight them for the user. Provide a short reason per event. Replaces the previous flag set for this turn.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "events": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "index": {"type": "integer"},
                                "reason": {"type": "string", "description": "<= 120 chars, why this event matters"},
                                "severity": {"type": "string", "enum": ["info", "warn", "error"], "default": "info"},
                            },
                            "required": ["index", "reason"],
                        },
                    },
                },
                "required": ["events"],
            },
        },
        {
            "name": "get_tool_result",
            "description": "Full tool result data for a tool_result event. Can be large — use sparingly.",
            "input_schema": {
                "type": "object",
                "properties": {"index": {"type": "integer"}, "max_chars": {"type": "integer", "default": 8000}},
                "required": ["index"],
            },
        },
    ]


def _run_tool(trace: ParsedTrace, name: str, args: dict) -> str:
    import re

    if name == "get_task_info":
        return json.dumps({
            **asdict(trace.task),
            "agents": trace.agents,
            "models": trace.models,
            "event_count": len(trace.events),
        }, default=str)

    if name == "get_summary":
        return json.dumps(compute_summary(trace), default=str)

    if name == "get_spans":
        spans = compute_spans(trace)
        if args.get("type"):
            spans = [s for s in spans if s["type"] == args["type"]]
        if args.get("agent"):
            spans = [s for s in spans if s.get("agent") == args["agent"]]
        if args.get("min_duration_ms") is not None:
            spans = [s for s in spans if s["duration_ms"] >= args["min_duration_ms"]]
        return json.dumps(spans, default=str)

    if name == "list_events":
        evs = trace.events
        if args.get("agent"):
            evs = [e for e in evs if e.agent == args["agent"]]
        if args.get("kind"):
            evs = [e for e in evs if e.kind == args["kind"]]
        if args.get("start_ms") is not None:
            evs = [e for e in evs if e.t_offset_ms >= args["start_ms"]]
        if args.get("end_ms") is not None:
            evs = [e for e in evs if e.t_offset_ms <= args["end_ms"]]
        lim = args.get("limit", 100)
        out = []
        for e in evs[:lim]:
            out.append({
                "index": e.index,
                "t_offset_ms": e.t_offset_ms,
                "agent": e.agent,
                "kind": e.kind,
                "direction": e.direction,
                "tool_name": e.tool_name,
                "model": e.model,
                "input_tokens": e.input_tokens,
                "output_tokens": e.output_tokens,
                "status_text": e.status_text,
                "text_preview": (e.text or "")[:120] if e.text else None,
            })
        return json.dumps(out, default=str)

    if name == "get_event":
        idx = args["index"]
        if idx < 0 or idx >= len(trace.events):
            return json.dumps({"error": "index out of range"})
        e = trace.events[idx]
        d = asdict(e)
        # truncate payload to keep response reasonable
        d["payload"] = _truncate_json(d["payload"], 6000)
        return json.dumps(d, default=str)

    if name == "search_text":
        pat = re.compile(args["pattern"], re.IGNORECASE)
        lim = args.get("limit", 20)
        hits = []
        for e in trace.events:
            blobs = [
                e.text or "",
                e.status_text or "",
                e.tool_name or "",
                json.dumps(e.tool_args, default=str) if e.tool_args else "",
            ]
            joined = "\n".join(blobs)
            if pat.search(joined):
                m = pat.search(joined)
                ctx = joined[max(0, m.start() - 60): m.end() + 60]
                hits.append({
                    "index": e.index,
                    "t_offset_ms": e.t_offset_ms,
                    "agent": e.agent,
                    "kind": e.kind,
                    "match_context": ctx,
                })
                if len(hits) >= lim:
                    break
        return json.dumps(hits, default=str)

    if name == "flag_events":
        items = args.get("events") or []
        valid = []
        for it in items:
            idx = it.get("index")
            if not isinstance(idx, int) or idx < 0 or idx >= len(trace.events):
                continue
            valid.append({
                "index": idx,
                "reason": str(it.get("reason", ""))[:200],
                "severity": it.get("severity", "info"),
            })
        return json.dumps({"flagged": len(valid), "events": valid})

    if name == "get_tool_result":
        idx = args["index"]
        max_chars = args.get("max_chars", 8000)
        if idx < 0 or idx >= len(trace.events):
            return json.dumps({"error": "index oob"})
        e = trace.events[idx]
        if e.kind != "tool_result":
            return json.dumps({"error": f"event {idx} is not a tool_result (kind={e.kind})"})
        # dig into payload for result_data
        from .parser import _extract_parts
        parts = _extract_parts(e.payload)
        for p in parts:
            if isinstance(p, dict) and isinstance(p.get("data"), dict) and "result_data" in p["data"]:
                rd = p["data"]["result_data"]
                s = json.dumps(rd, default=str)
                truncated = len(s) > max_chars
                return json.dumps({
                    "index": idx,
                    "tool_name": e.tool_name,
                    "result_size_chars": len(s),
                    "truncated": truncated,
                    "data": s[:max_chars],
                })
        return json.dumps({"error": "no result_data in event"})

    return json.dumps({"error": f"unknown tool {name}"})


def _truncate_json(obj, max_chars: int):
    s = json.dumps(obj, default=str)
    if len(s) <= max_chars:
        return obj
    return {"_truncated": True, "_size_chars": len(s), "_preview": s[:max_chars]}


async def chat_stream(trace: ParsedTrace, messages: list[dict]) -> AsyncIterator[bytes]:
    """SSE stream of chat events.

    Events emitted (each as `data: <json>\\n\\n`):
      - {type: "text", delta: "..."}
      - {type: "tool_use", name, input}
      - {type: "tool_result", name, output_preview}
      - {type: "done"}
      - {type: "error", error: "..."}
    """
    provider = get_provider()
    if provider is None:
        yield _sse({"type": "error", "error": "No LLM credentials set: configure ANTHROPIC_API_KEY or LLM_SERVICE_ENDPOINT+LLM_SERVICE_API_KEY"})
        return

    convo = [{"role": m["role"], "content": m["content"]} for m in messages]

    try:
        for _ in range(8):  # cap tool loops
            text_parts: list[str] = []
            tool_uses: list[dict] = []
            stop_reason = "end_turn"

            async for ev in provider.stream_turn(SYSTEM, _tools(), convo):
                t = ev["type"]
                if t == "text_delta":
                    text_parts.append(ev["text"])
                    yield _sse({"type": "text", "delta": ev["text"]})
                elif t == "tool_use":
                    tool_uses.append(ev)
                    yield _sse({"type": "tool_use", "name": ev["name"], "input": ev["input"]})
                elif t == "stop":
                    stop_reason = ev["reason"]

            if stop_reason != "tool_use" or not tool_uses:
                yield _sse({"type": "done"})
                return

            provider.append_assistant(convo, text_parts, tool_uses)
            results = []
            for tu in tool_uses:
                try:
                    out = _run_tool(trace, tu["name"], tu["input"] or {})
                except Exception as e:
                    out = json.dumps({"error": str(e)})
                yield _sse({"type": "tool_result", "name": tu["name"], "output_preview": out[:300]})
                if tu["name"] == "flag_events":
                    try:
                        parsed = json.loads(out)
                        yield _sse({"type": "flagged_events", "items": parsed.get("events", [])})
                    except Exception:
                        pass
                results.append({"id": tu["id"], "name": tu["name"], "output": out})
            provider.append_tool_results(convo, results)

        yield _sse({"type": "error", "error": "tool loop cap reached"})
    except Exception as e:
        yield _sse({"type": "error", "error": str(e)})


def _sse(obj: dict) -> bytes:
    return f"data: {json.dumps(obj)}\n\n".encode("utf-8")
