"""Per-user projects: lightweight grouping of stim files.

State lives in ``<BASE>/users/<user_key>/projects.json``.
"""
from __future__ import annotations

import json
import time
import uuid
from threading import Lock

from .store import user_root

_lock = Lock()


def _meta_path(user_key: str):
    return user_root(user_key) / "projects.json"


def _load(user_key: str) -> dict:
    p = _meta_path(user_key)
    if not p.exists():
        return {"projects": [], "assignments": {}}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {"projects": [], "assignments": {}}


def _save(user_key: str, data: dict) -> None:
    _meta_path(user_key).write_text(json.dumps(data, indent=2), encoding="utf-8")


def list_projects(user_key: str) -> list[dict]:
    with _lock:
        return list(_load(user_key).get("projects", []))


def create_project(user_key: str, name: str) -> dict:
    name = (name or "").strip()
    if not name:
        raise ValueError("name required")
    with _lock:
        data = _load(user_key)
        proj = {"id": "p_" + uuid.uuid4().hex[:10], "name": name, "created_at": int(time.time())}
        data["projects"].append(proj)
        _save(user_key, data)
        return proj


def rename_project(user_key: str, pid: str, name: str) -> dict | None:
    name = (name or "").strip()
    if not name:
        raise ValueError("name required")
    with _lock:
        data = _load(user_key)
        for p in data["projects"]:
            if p["id"] == pid:
                p["name"] = name
                _save(user_key, data)
                return p
        return None


def delete_project(user_key: str, pid: str) -> bool:
    with _lock:
        data = _load(user_key)
        before = len(data["projects"])
        data["projects"] = [p for p in data["projects"] if p["id"] != pid]
        data["assignments"] = {k: v for k, v in data["assignments"].items() if v != pid}
        changed = len(data["projects"]) != before
        if changed:
            _save(user_key, data)
        return changed


def get_assignments(user_key: str) -> dict[str, str]:
    with _lock:
        return dict(_load(user_key).get("assignments", {}))


def assign_file(user_key: str, fid: str, pid: str | None) -> None:
    with _lock:
        data = _load(user_key)
        if pid is None:
            data["assignments"].pop(fid, None)
        else:
            if not any(p["id"] == pid for p in data["projects"]):
                raise ValueError(f"unknown project {pid}")
            data["assignments"][fid] = pid
        _save(user_key, data)


def cleanup_missing(user_key: str, existing_file_ids: set[str]) -> None:
    with _lock:
        data = _load(user_key)
        before = len(data["assignments"])
        data["assignments"] = {
            fid: pid for fid, pid in data["assignments"].items() if fid in existing_file_ids
        }
        if len(data["assignments"]) != before:
            _save(user_key, data)
