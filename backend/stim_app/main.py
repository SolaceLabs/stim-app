from __future__ import annotations

from dataclasses import asdict
from dotenv import load_dotenv, find_dotenv
from fastapi import Depends, FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import os as _os
# Load .env from backend/ (may be a symlink to the sam repo's .env), falling
# back to upward search from cwd. Explicit path first so it works regardless
# of the directory uvicorn is launched from.
_backend_env = _os.path.join(_os.path.dirname(_os.path.dirname(__file__)), ".env")
if _os.path.exists(_backend_env):
    load_dotenv(_backend_env, override=True)
else:
    load_dotenv(find_dotenv(usecwd=True), override=True)

from .auth import User, auth_router, get_current_user
from .parser import parse_stim, compute_summary, compute_spans
from . import store, projects, chats
from .chat import chat_stream
from .chat_cc import chat_stream_cc


app = FastAPI(title="stim-app")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)

app.include_router(auth_router)


@app.get("/api/health")
def health():
    return {"ok": True}


# ---------- Files ----------

@app.get("/api/files")
def list_files(user: User = Depends(get_current_user)):
    files = store.list_files(user.dir_key)
    projects.cleanup_missing(user.dir_key, {f["id"] for f in files})
    assignments = projects.get_assignments(user.dir_key)
    for f in files:
        f["project_id"] = assignments.get(f["id"])
    return files


@app.post("/api/upload")
async def upload(file: UploadFile = File(...), user: User = Depends(get_current_user)):
    content = (await file.read()).decode("utf-8", errors="replace")
    try:
        trace = parse_stim(file.filename or "upload.stim", content)
    except Exception as e:
        raise HTTPException(400, f"Parse error: {e}")
    fid = store.put(user.dir_key, trace, content)
    return {"id": fid, **trace.to_summary()}


@app.delete("/api/files/{fid}")
def delete_file(fid: str, user: User = Depends(get_current_user)):
    if not store.delete(user.dir_key, fid):
        raise HTTPException(404, "not found")
    chats.delete_thread(user.dir_key, fid)
    return {"ok": True}


@app.get("/api/files/{fid}/summary")
def get_summary(fid: str, user: User = Depends(get_current_user)):
    t = store.get(user.dir_key, fid)
    if not t:
        raise HTTPException(404, "not found")
    return {
        **t.to_summary(),
        "derived": compute_summary(t),
    }


@app.get("/api/files/{fid}/events")
def get_events(fid: str, user: User = Depends(get_current_user)):
    t = store.get(user.dir_key, fid)
    if not t:
        raise HTTPException(404, "not found")
    return [
        {k: v for k, v in asdict(e).items() if k != "payload"}
        for e in t.events
    ]


@app.get("/api/files/{fid}/events/{idx}")
def get_event(fid: str, idx: int, user: User = Depends(get_current_user)):
    t = store.get(user.dir_key, fid)
    if not t:
        raise HTTPException(404, "not found")
    if idx < 0 or idx >= len(t.events):
        raise HTTPException(404, "event oob")
    return asdict(t.events[idx])


@app.get("/api/files/{fid}/spans")
def get_spans(fid: str, user: User = Depends(get_current_user)):
    t = store.get(user.dir_key, fid)
    if not t:
        raise HTTPException(404, "not found")
    return compute_spans(t)


# ---------- Projects ----------

class ProjectBody(BaseModel):
    name: str


class AssignBody(BaseModel):
    project_id: str | None = None


@app.get("/api/projects")
def api_list_projects(user: User = Depends(get_current_user)):
    return projects.list_projects(user.dir_key)


@app.post("/api/projects")
def api_create_project(body: ProjectBody, user: User = Depends(get_current_user)):
    try:
        return projects.create_project(user.dir_key, body.name)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.patch("/api/projects/{pid}")
def api_rename_project(pid: str, body: ProjectBody, user: User = Depends(get_current_user)):
    try:
        p = projects.rename_project(user.dir_key, pid, body.name)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not p:
        raise HTTPException(404, "not found")
    return p


@app.delete("/api/projects/{pid}")
def api_delete_project(pid: str, user: User = Depends(get_current_user)):
    if not projects.delete_project(user.dir_key, pid):
        raise HTTPException(404, "not found")
    return {"ok": True}


@app.patch("/api/files/{fid}/project")
def api_assign_file(fid: str, body: AssignBody, user: User = Depends(get_current_user)):
    if store.get(user.dir_key, fid) is None:
        raise HTTPException(404, "file not found")
    try:
        projects.assign_file(user.dir_key, fid, body.project_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


# ---------- Chat history ----------

class ThreadBody(BaseModel):
    messages: list[dict]


@app.get("/api/files/{fid}/chat")
def get_chat(fid: str, user: User = Depends(get_current_user)):
    if store.get(user.dir_key, fid) is None:
        raise HTTPException(404, "file not found")
    return {"messages": chats.load_thread(user.dir_key, fid)}


@app.put("/api/files/{fid}/chat")
def put_chat(fid: str, body: ThreadBody, user: User = Depends(get_current_user)):
    if store.get(user.dir_key, fid) is None:
        raise HTTPException(404, "file not found")
    chats.save_thread(user.dir_key, fid, body.messages)
    return {"ok": True}


@app.delete("/api/files/{fid}/chat")
def del_chat(fid: str, user: User = Depends(get_current_user)):
    chats.delete_thread(user.dir_key, fid)
    return {"ok": True}


# ---------- Chat streaming ----------

class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    file_id: str
    messages: list[ChatMessage]
    repo_path: str | None = None


@app.post("/api/chat")
async def chat(req: ChatRequest, user: User = Depends(get_current_user)):
    from fastapi.responses import StreamingResponse
    t = store.get(user.dir_key, req.file_id)
    if not t:
        raise HTTPException(404, "file not found")
    return StreamingResponse(
        chat_stream(t, [m.dict() for m in req.messages]),
        media_type="text/event-stream",
    )


@app.post("/api/chat-cc")
async def chat_cc(req: ChatRequest, user: User = Depends(get_current_user)):
    from fastapi.responses import StreamingResponse
    t = store.get(user.dir_key, req.file_id)
    if not t:
        raise HTTPException(404, "file not found")
    return StreamingResponse(
        chat_stream_cc(t, [m.dict() for m in req.messages], req.repo_path),
        media_type="text/event-stream",
    )
