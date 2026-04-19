"""Headless Claude Code chat backend.

Spawns `claude -p <prompt> --output-format stream-json` with cwd set to the
user-provided SAM repo path. Dumps the parsed trace to a temp JSON file and
tells Claude Code where to find it via --append-system-prompt.

Claude Code's stream-json format emits one JSON object per line covering:
  - {"type": "system", "subtype": "init", ...}
  - {"type": "assistant", "message": {"content": [...]}}
  - {"type": "user", "message": {"content": [{"type":"tool_result",...}]}}
  - {"type": "result", ...}

We translate those into our SSE event shape so the frontend renders both
modes identically.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import tempfile
from dataclasses import asdict
from pathlib import Path
from typing import AsyncIterator

from .parser import ParsedTrace, compute_summary, compute_spans


REPO_CACHE_DIR = Path(os.environ.get("STIM_APP_REPO_CACHE", os.path.expanduser("~/.stim-app/repos")))
REPO_CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _is_url(s: str) -> bool:
    return bool(re.match(r"^(https?://|git@)", s.strip()))


def _parse_repo_url(url: str) -> tuple[str, str | None]:
    """Return (clone_url, branch_or_None). Handles GitHub tree URLs."""
    url = url.strip().rstrip("/")
    # github tree url: https://github.com/org/repo/tree/branch[/subpath]
    m = re.match(r"^(https://github\.com/[^/]+/[^/]+)/tree/([^/]+)(?:/.*)?$", url)
    if m:
        return (m.group(1) + ".git", m.group(2))
    if url.startswith("https://github.com/") and not url.endswith(".git"):
        return (url + ".git", None)
    return (url, None)


async def _ensure_repo(url: str) -> tuple[str, str]:
    """Clone or update a remote repo into the cache. Returns (local_path, status_msg)."""
    clone_url, branch = _parse_repo_url(url)
    key = hashlib.sha1(f"{clone_url}@{branch or ''}".encode()).hexdigest()[:12]
    dest = REPO_CACHE_DIR / key
    if dest.exists() and (dest / ".git").exists():
        # Fast path: already cloned. Best-effort fetch, non-fatal on failure.
        proc = await asyncio.create_subprocess_exec(
            "git", "-C", str(dest), "fetch", "--depth", "1", "origin",
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        )
        await proc.wait()
        if branch:
            await (await asyncio.create_subprocess_exec(
                "git", "-C", str(dest), "checkout", branch,
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            )).wait()
        return (str(dest), f"cached at {dest}")

    args = ["git", "clone", "--depth", "1"]
    if branch:
        args += ["--branch", branch]
    args += [clone_url, str(dest)]
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    _, err = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"git clone failed: {err.decode('utf-8', 'replace')[:400]}")
    return (str(dest), f"cloned to {dest}")


SYSTEM_SUFFIX_TEMPLATE = """
[stim-explorer context]

You are helping diagnose a Solace Agent Mesh (SAM) agent execution trace.

The parsed trace is dumped as JSON at: {trace_path}
Use the Read tool to inspect it. Shape:
  - task: metadata (task_id, duration_ms, initial_request_text)
  - events: array of events with (index, t_offset_ms, agent, kind, tool_name, input_tokens, output_tokens, text, tool_args, tool_result_preview, ...)
  - summary: derived analytics (total_ms, llm_ms, tool_ms, per_agent_tokens, slowest_spans)
  - spans: paired LLM/tool spans with durations

The current working directory is the SAM source tree. You may Grep/Read it to
validate proposed fixes or find implementations referenced in the trace.

When diagnosing latency, start by reading summary and slowest_spans, then drill
into specific events. When proposing fixes, cite exact files and line numbers
from the SAM repo. Keep responses concise.
"""


def _dump_trace_json(trace: ParsedTrace) -> str:
    d = {
        "task": asdict(trace.task),
        "agents": trace.agents,
        "models": trace.models,
        "summary": compute_summary(trace),
        "spans": compute_spans(trace),
        "events": [
            {k: v for k, v in asdict(e).items() if k != "payload"}
            for e in trace.events
        ],
    }
    fd, path = tempfile.mkstemp(prefix="stim-", suffix=".json", dir=tempfile.gettempdir())
    with os.fdopen(fd, "w") as f:
        json.dump(d, f, default=str)
    return path


def _build_prompt(messages: list[dict]) -> str:
    parts = []
    for m in messages:
        role = m["role"].upper()
        parts.append(f"[{role}]\n{m['content']}")
    return "\n\n".join(parts)


async def chat_stream_cc(
    trace: ParsedTrace,
    messages: list[dict],
    repo_path: str | None,
) -> AsyncIterator[bytes]:
    claude_bin = shutil.which("claude")
    if not claude_bin:
        yield _sse({"type": "error", "error": "`claude` CLI not found on PATH. Install Claude Code."})
        return

    if not repo_path:
        yield _sse({"type": "error", "error": "repo_path is empty"})
        return

    # Resolve URL → local clone
    if _is_url(repo_path):
        yield _sse({"type": "tool_use", "name": "git_clone", "input": {"url": repo_path}})
        try:
            local_path, status = await _ensure_repo(repo_path)
        except Exception as e:
            yield _sse({"type": "error", "error": f"repo fetch failed: {e}"})
            return
        yield _sse({"type": "tool_result", "name": "git_clone", "output_preview": status})
        repo_path = local_path

    if not os.path.isdir(repo_path):
        yield _sse({"type": "error", "error": f"repo_path not found: {repo_path}"})
        return

    trace_path = _dump_trace_json(trace)
    system_suffix = SYSTEM_SUFFIX_TEMPLATE.format(trace_path=trace_path)
    prompt = _build_prompt(messages)

    args = [
        claude_bin,
        "-p", prompt,
        "--output-format", "stream-json",
        "--verbose",
        "--append-system-prompt", system_suffix,
        "--permission-mode", "bypassPermissions",
        "--allowedTools", "Read,Grep,Glob,Bash,WebFetch",
    ]

    proc = await asyncio.create_subprocess_exec(
        *args,
        cwd=repo_path,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    assert proc.stdout is not None
    try:
        async for line in proc.stdout:
            try:
                obj = json.loads(line.decode("utf-8"))
            except Exception:
                continue
            async for ev in _translate(obj):
                yield ev
        await proc.wait()
        if proc.returncode and proc.returncode != 0:
            stderr = (await proc.stderr.read()).decode("utf-8", errors="replace") if proc.stderr else ""
            yield _sse({"type": "error", "error": f"claude exited {proc.returncode}: {stderr[:500]}"})
        else:
            yield _sse({"type": "done"})
    finally:
        try:
            os.remove(trace_path)
        except Exception:
            pass


async def _translate(obj: dict) -> AsyncIterator[bytes]:
    t = obj.get("type")
    if t == "assistant":
        msg = obj.get("message", {})
        for block in msg.get("content", []) or []:
            bt = block.get("type")
            if bt == "text":
                txt = block.get("text", "")
                if txt:
                    yield _sse({"type": "text", "delta": txt})
            elif bt == "tool_use":
                yield _sse({"type": "tool_use", "name": block.get("name"), "input": block.get("input")})
            elif bt == "thinking":
                thought = block.get("thinking", "")
                if thought:
                    yield _sse({"type": "thinking", "delta": thought[:200]})
    elif t == "user":
        msg = obj.get("message", {})
        for block in msg.get("content", []) or []:
            if isinstance(block, dict) and block.get("type") == "tool_result":
                content = block.get("content", "")
                if isinstance(content, list):
                    content = " ".join(c.get("text", "") for c in content if isinstance(c, dict))
                preview = (content or "")[:300] if isinstance(content, str) else str(content)[:300]
                yield _sse({"type": "tool_result", "name": "", "output_preview": preview})
    elif t == "result":
        # final result event; handled by end-of-stream
        pass


def _sse(obj: dict) -> bytes:
    return f"data: {json.dumps(obj)}\n\n".encode("utf-8")
