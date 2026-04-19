"""LLM provider abstraction: native Anthropic or OpenAI-compatible (e.g. litellm proxy).

Both providers expose the same streaming interface used by chat.py:

    provider.stream_turn(system, tools, messages) -> async iterator of events:
        {"type": "text_delta", "text": str}
        {"type": "tool_use", "id": str, "name": str, "input": dict}
        {"type": "stop", "reason": str}   # "tool_use" | "end_turn" | other

    provider.append_assistant(messages, text_blocks, tool_uses)
    provider.append_tool_results(messages, results)   # results: [{id, name, output}]

Messages are kept in each provider's native wire format so we don't lose fidelity.
"""
from __future__ import annotations

import json
import os
from typing import AsyncIterator


def get_provider():
    if os.environ.get("LLM_SERVICE_ENDPOINT") and os.environ.get("LLM_SERVICE_API_KEY"):
        return LiteLLMProvider()
    if os.environ.get("ANTHROPIC_API_KEY"):
        return AnthropicProvider()
    return None


class AnthropicProvider:
    name = "anthropic"

    def __init__(self):
        from anthropic import Anthropic
        self.client = Anthropic()
        self.model = os.environ.get("STIM_APP_MODEL", "claude-sonnet-4-6")

    async def stream_turn(self, system: str, tools: list[dict], messages: list[dict]) -> AsyncIterator[dict]:
        # Anthropic tools use input_schema natively
        with self.client.messages.stream(
            model=self.model,
            max_tokens=4096,
            system=system,
            tools=tools,
            messages=messages,
        ) as stream:
            for event in stream:
                et = getattr(event, "type", None)
                if et == "content_block_delta":
                    delta = event.delta
                    if getattr(delta, "type", None) == "text_delta":
                        yield {"type": "text_delta", "text": delta.text}
            final = stream.get_final_message()

        for block in final.content:
            if block.type == "tool_use":
                yield {
                    "type": "tool_use",
                    "id": block.id,
                    "name": block.name,
                    "input": block.input or {},
                }
        yield {"type": "stop", "reason": final.stop_reason or "end_turn"}

    def append_assistant(self, messages: list[dict], text_blocks: list[str], tool_uses: list[dict]) -> None:
        content = []
        for t in text_blocks:
            if t:
                content.append({"type": "text", "text": t})
        for tu in tool_uses:
            content.append({"type": "tool_use", "id": tu["id"], "name": tu["name"], "input": tu["input"]})
        messages.append({"role": "assistant", "content": content})

    def append_tool_results(self, messages: list[dict], results: list[dict]) -> None:
        messages.append({
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": r["id"], "content": r["output"]}
                for r in results
            ],
        })


class LiteLLMProvider:
    """OpenAI-compatible endpoint (e.g. litellm proxy).

    Uses OpenAI SDK streaming. Accumulates tool_call deltas across chunks before
    emitting a single `tool_use` event per call.
    """
    name = "openai"

    def __init__(self):
        from openai import OpenAI
        base = os.environ["LLM_SERVICE_ENDPOINT"].rstrip("/")
        if not base.endswith("/v1"):
            base = base + "/v1"
        self.client = OpenAI(base_url=base, api_key=os.environ["LLM_SERVICE_API_KEY"])
        self.model = (
            os.environ.get("STIM_APP_MODEL")
            or os.environ.get("LLM_SERVICE_PLANNING_MODEL_NAME")
            or "gpt-4o"
        )

    @staticmethod
    def _translate_tools(tools: list[dict]) -> list[dict]:
        out = []
        for t in tools:
            out.append({
                "type": "function",
                "function": {
                    "name": t["name"],
                    "description": t.get("description", ""),
                    "parameters": t.get("input_schema") or {"type": "object", "properties": {}},
                },
            })
        return out

    async def stream_turn(self, system: str, tools: list[dict], messages: list[dict]) -> AsyncIterator[dict]:
        oai_messages = [{"role": "system", "content": system}, *messages]
        stream = self.client.chat.completions.create(
            model=self.model,
            messages=oai_messages,
            tools=self._translate_tools(tools),
            max_tokens=4096,
            stream=True,
        )

        # Accumulate tool calls across chunks, keyed by index
        tool_acc: dict[int, dict] = {}
        finish_reason = None

        for chunk in stream:
            if not chunk.choices:
                continue
            choice = chunk.choices[0]
            delta = choice.delta
            if delta is None:
                continue

            if getattr(delta, "content", None):
                yield {"type": "text_delta", "text": delta.content}

            for tc in (getattr(delta, "tool_calls", None) or []):
                idx = tc.index
                slot = tool_acc.setdefault(idx, {"id": "", "name": "", "args": ""})
                if tc.id:
                    slot["id"] = tc.id
                fn = getattr(tc, "function", None)
                if fn:
                    if getattr(fn, "name", None):
                        slot["name"] = fn.name
                    if getattr(fn, "arguments", None):
                        slot["args"] += fn.arguments

            if choice.finish_reason:
                finish_reason = choice.finish_reason

        for idx in sorted(tool_acc.keys()):
            slot = tool_acc[idx]
            try:
                parsed = json.loads(slot["args"]) if slot["args"] else {}
            except json.JSONDecodeError:
                parsed = {}
            yield {
                "type": "tool_use",
                "id": slot["id"],
                "name": slot["name"],
                "input": parsed,
            }

        reason = "tool_use" if finish_reason == "tool_calls" else (finish_reason or "end_turn")
        yield {"type": "stop", "reason": reason}

    def append_assistant(self, messages: list[dict], text_blocks: list[str], tool_uses: list[dict]) -> None:
        msg: dict = {"role": "assistant"}
        text = "".join(t for t in text_blocks if t)
        msg["content"] = text or None
        if tool_uses:
            msg["tool_calls"] = [
                {
                    "id": tu["id"],
                    "type": "function",
                    "function": {"name": tu["name"], "arguments": json.dumps(tu["input"] or {})},
                }
                for tu in tool_uses
            ]
        messages.append(msg)

    def append_tool_results(self, messages: list[dict], results: list[dict]) -> None:
        for r in results:
            messages.append({
                "role": "tool",
                "tool_call_id": r["id"],
                "content": r["output"],
            })
