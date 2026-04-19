"""Per-user chat thread persistence, keyed by file (stim) id.

Files live under ``<BASE>/users/<user_key>/chats/<fid>.json`` and contain the
raw message list the frontend already keeps (role + content + events).
"""
from __future__ import annotations

import json
from threading import Lock

from .store import user_root

_lock = Lock()


def _path(user_key: str, fid: str):
    d = user_root(user_key) / "chats"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{fid}.json"


def load_thread(user_key: str, fid: str) -> list[dict]:
    p = _path(user_key, fid)
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return []


def save_thread(user_key: str, fid: str, messages: list[dict]) -> None:
    p = _path(user_key, fid)
    with _lock:
        p.write_text(json.dumps(messages), encoding="utf-8")


def delete_thread(user_key: str, fid: str) -> bool:
    p = _path(user_key, fid)
    if p.exists():
        p.unlink()
        return True
    return False
