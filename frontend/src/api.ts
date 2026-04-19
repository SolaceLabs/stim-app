import type { EventRow, FileItem, Span, Summary } from "./types";

const BASE = "/api";

export async function uploadFile(f: File): Promise<Summary> {
  const fd = new FormData();
  fd.append("file", f);
  const res = await fetch(`${BASE}/upload`, { method: "POST", body: fd });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function listFiles(): Promise<FileItem[]> {
  return (await fetch(`${BASE}/files`)).json();
}

export interface Project { id: string; name: string; created_at?: number }

export async function listProjects(): Promise<Project[]> {
  return (await fetch(`${BASE}/projects`)).json();
}

export async function createProject(name: string): Promise<Project> {
  const r = await fetch(`${BASE}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function renameProject(id: string, name: string): Promise<Project> {
  const r = await fetch(`${BASE}/projects/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function deleteProject(id: string): Promise<void> {
  const r = await fetch(`${BASE}/projects/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(await r.text());
}

export async function loadChatThread(fileId: string): Promise<any[]> {
  const r = await fetch(`${BASE}/files/${fileId}/chat`);
  if (!r.ok) return [];
  const j = await r.json();
  return j.messages || [];
}

export async function saveChatThread(fileId: string, messages: any[]): Promise<void> {
  await fetch(`${BASE}/files/${fileId}/chat`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
}

export async function deleteChatThread(fileId: string): Promise<void> {
  await fetch(`${BASE}/files/${fileId}/chat`, { method: "DELETE" });
}

export async function assignFile(fileId: string, projectId: string | null): Promise<void> {
  const r = await fetch(`${BASE}/files/${fileId}/project`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId }),
  });
  if (!r.ok) throw new Error(await r.text());
}

export async function getSummary(id: string): Promise<Summary> {
  const r = await fetch(`${BASE}/files/${id}/summary`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getEvents(id: string): Promise<EventRow[]> {
  const r = await fetch(`${BASE}/files/${id}/events`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getEvent(id: string, idx: number) {
  const r = await fetch(`${BASE}/files/${id}/events/${idx}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getSpans(id: string): Promise<Span[]> {
  const r = await fetch(`${BASE}/files/${id}/spans`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function deleteFile(id: string) {
  await fetch(`${BASE}/files/${id}`, { method: "DELETE" });
}

export interface FlaggedEvent {
  index: number;
  reason: string;
  severity?: "info" | "warn" | "error";
}

export interface ChatEvent {
  type: "text" | "tool_use" | "tool_result" | "done" | "error" | "thinking" | "flagged_events";
  delta?: string;
  name?: string;
  input?: unknown;
  output_preview?: string;
  error?: string;
  items?: FlaggedEvent[];
}

export async function* chatStream(
  fileId: string,
  messages: { role: string; content: string }[],
  mode: "sdk" | "cc" = "sdk",
  repoPath?: string,
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const endpoint = mode === "cc" ? `${BASE}/chat-cc` : `${BASE}/chat`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId, messages, repo_path: repoPath }),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(await res.text());
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    // parse SSE events split by \n\n
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data: ")) {
          try {
            yield JSON.parse(line.slice(6));
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
}
