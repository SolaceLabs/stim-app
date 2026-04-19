"""Per-user trace store with disk persistence across backend reloads.

Layout:
    ~/.stim-app/users/<user_key>/uploads/<fid>.stim
    ~/.stim-app/users/<user_key>/uploads/<fid>.name
"""
from __future__ import annotations

import os
import uuid
from pathlib import Path
from threading import Lock

from .parser import ParsedTrace, parse_stim

BASE_DIR = Path(os.environ.get("STIM_APP_STORE_DIR", os.path.expanduser("~/.stim-app")))
BASE_DIR.mkdir(parents=True, exist_ok=True)

_lock = Lock()
# Cache keyed by (user_key, fid) so multiple users can't collide.
_cache: dict[tuple[str, str], ParsedTrace] = {}


def _user_dir(user_key: str) -> Path:
    p = BASE_DIR / "users" / user_key / "uploads"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _path_for(user_key: str, fid: str) -> Path:
    return _user_dir(user_key) / f"{fid}.stim"


def _load(user_key: str, fid: str) -> ParsedTrace | None:
    p = _path_for(user_key, fid)
    if not p.exists():
        return None
    try:
        meta_path = _user_dir(user_key) / f"{fid}.name"
        filename = meta_path.read_text().strip() if meta_path.exists() else p.name
        content = p.read_text(encoding="utf-8", errors="replace")
        return parse_stim(filename, content)
    except Exception:
        return None


def put(user_key: str, trace: ParsedTrace, raw_content: str) -> str:
    fid = uuid.uuid4().hex[:12]
    _path_for(user_key, fid).write_text(raw_content, encoding="utf-8")
    (_user_dir(user_key) / f"{fid}.name").write_text(trace.filename, encoding="utf-8")
    with _lock:
        _cache[(user_key, fid)] = trace
    return fid


def get(user_key: str, fid: str) -> ParsedTrace | None:
    key = (user_key, fid)
    with _lock:
        t = _cache.get(key)
        if t is not None:
            return t
    t = _load(user_key, fid)
    if t is not None:
        with _lock:
            _cache[key] = t
    return t


def list_files(user_key: str) -> list[dict]:
    items: dict[str, ParsedTrace] = {}
    with _lock:
        for (uk, fid), t in _cache.items():
            if uk == user_key:
                items[fid] = t
    for p in _user_dir(user_key).glob("*.stim"):
        fid = p.stem
        if fid not in items:
            t = _load(user_key, fid)
            if t is not None:
                with _lock:
                    _cache[(user_key, fid)] = t
                items[fid] = t
    return [
        {
            "id": fid,
            "filename": t.filename,
            "task_id": t.task.task_id,
            "duration_ms": t.task.duration_ms,
            "event_count": len(t.events),
        }
        for fid, t in items.items()
    ]


def delete(user_key: str, fid: str) -> bool:
    key = (user_key, fid)
    with _lock:
        _cache.pop(key, None)
    removed = False
    for suffix in (".stim", ".name"):
        p = _user_dir(user_key) / f"{fid}{suffix}"
        if p.exists():
            p.unlink()
            removed = True
    return removed


def user_root(user_key: str) -> Path:
    p = BASE_DIR / "users" / user_key
    p.mkdir(parents=True, exist_ok=True)
    return p
