import { useEffect, useRef, useState } from "react";
import { chatStream, deleteChatThread, loadChatThread, saveChatThread, type ChatEvent } from "../api";
import { Markdown } from "./Markdown";

type Msg =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; events: ChatEvent[] };

const STORAGE_REPO_KEY = "stim-app.repo_path";

export function ChatPanel({ fileId }: { fileId: string }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"sdk" | "cc">("sdk");
  const [repoPath, setRepoPath] = useState<string>(() => localStorage.getItem(STORAGE_REPO_KEY) || "/Users/amir.ghasemi/code/samdev/sam");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    localStorage.setItem(STORAGE_REPO_KEY, repoPath);
  }, [repoPath]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [msgs]);

  // Load thread when switching stim files.
  useEffect(() => {
    let cancelled = false;
    loadChatThread(fileId).then((m) => { if (!cancelled) setMsgs(m as Msg[]); });
    return () => { cancelled = true; };
  }, [fileId]);

  // Persist thread server-side; skip while streaming to avoid flooding writes.
  useEffect(() => {
    if (busy) return;
    if (msgs.length === 0) {
      deleteChatThread(fileId).catch(() => {});
    } else {
      saveChatThread(fileId, msgs).catch(() => {});
    }
  }, [fileId, msgs, busy]);

  async function send(override?: string) {
    const text = (override ?? input).trim();
    if (!text || busy) return;
    if (override === undefined) setInput("");
    const next: Msg[] = [...msgs, { role: "user", content: text }, { role: "assistant", content: "", events: [] }];
    setMsgs(next);
    setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const toSend = next
        .filter((m) => m.role === "user" || (m.role === "assistant" && m.content))
        .map((m) => ({ role: m.role, content: m.content }));
      for await (const ev of chatStream(fileId, toSend, mode, mode === "cc" ? repoPath : undefined, ac.signal)) {
        if (ev.type === "flagged_events" && ev.items) {
          window.dispatchEvent(new CustomEvent("stim:flag-events", { detail: ev.items }));
        }
        setMsgs((cur) => {
          const last = cur[cur.length - 1];
          if (last.role !== "assistant") return cur;
          const updated = { ...last, events: [...last.events, ev] };
          if (ev.type === "text" && ev.delta) updated.content = (updated.content || "") + ev.delta;
          return [...cur.slice(0, -1), updated];
        });
        if (ev.type === "done" || ev.type === "error") break;
      }
    } catch (e: any) {
      const aborted = e?.name === "AbortError" || ac.signal.aborted;
      setMsgs((cur) => {
        const last = cur[cur.length - 1];
        if (last.role !== "assistant") return cur;
        const ev: ChatEvent = aborted
          ? { type: "error", error: "stopped by user" }
          : { type: "error", error: e.message };
        return [...cur.slice(0, -1), { ...last, events: [...last.events, ev] }];
      });
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  // Keep a ref to the latest send so the window-event listener (below) can
  // always call the up-to-date closure without re-attaching on every render.
  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    const handler = (ev: Event) => {
      const { context, question } = (ev as CustomEvent<{ context: string; question: string }>).detail || ({} as any);
      if (!question) return;
      const composed = context ? `[${context}]\n${question}` : question;
      sendRef.current(composed);
    };
    window.addEventListener("stim:ask-ai", handler as EventListener);
    return () => window.removeEventListener("stim:ask-ai", handler as EventListener);
  }, []);

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-border flex items-center gap-2 text-xs">
        <div className="font-semibold">Chat</div>
        {msgs.length > 0 && (
          <button
            onClick={() => {
              if (busy) return;
              setMsgs([]);
              window.dispatchEvent(new CustomEvent("stim:flag-events", { detail: [] }));
            }}
            disabled={busy}
            className="text-muted hover:text-fg disabled:opacity-40"
            title="Clear chat for this trace"
          >clear</button>
        )}
        <div className="flex-1" />
        <div className="flex rounded border border-border overflow-hidden">
          <button
            className={`px-2 py-0.5 ${mode === "sdk" ? "bg-accent/30 text-fg" : "text-muted hover:bg-panel2"}`}
            onClick={() => setMode("sdk")}
            title="Quick — Claude analyzes only the trace. Fastest, no code access."
          >quick</button>
          <button
            className={`px-2 py-0.5 ${mode === "cc" ? "bg-accent2/30 text-fg" : "text-muted hover:bg-panel2"}`}
            onClick={() => setMode("cc")}
            title="Deep — a headless coding agent analyzes the trace AND explores the codebase (local path or GitHub URL) to find root causes and propose fixes. Slower."
          >deep</button>
        </div>
      </div>
      {mode === "cc" && (
        <div className="px-3 py-2 border-b border-border text-xs">
          <label className="text-muted">Repo path or GitHub URL</label>
          <input
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            placeholder="/path/to/repo  or  https://github.com/org/repo[/tree/branch]"
            className="w-full mt-1 bg-panel2 border border-border rounded px-2 py-1 mono text-xs"
          />
        </div>
      )}
      <div ref={scrollRef} className="flex-1 overflow-auto p-3 space-y-4 text-sm">
        {msgs.length === 0 && (
          <div className="text-muted text-xs space-y-2">
            <div>Try asking:</div>
            <div className="space-y-1">
              {[
                "Where is time spent in this trace?",
                "What's the slowest LLM call and why?",
                "Are there redundant LLM calls?",
                "Summarize tool result sizes",
              ].map((q) => (
                <button
                  key={q}
                  className="block text-left w-full px-2 py-1 rounded border border-border hover:bg-panel2"
                  onClick={() => setInput(q)}
                >{q}</button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, i) => (
          <MessageBubble key={i} msg={m} isLast={i === msgs.length - 1} busy={busy} />
        ))}
      </div>
      <div className="p-2 border-t border-border flex gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={busy ? "Waiting for AI response…" : "Ask about this trace…"}
          className="flex-1 bg-panel2 border border-border rounded px-2 py-1.5 text-sm resize-none disabled:opacity-50 disabled:cursor-not-allowed"
          rows={2}
          disabled={busy}
        />
        {busy ? (
          <button
            onClick={stop}
            title="Stop generating"
            className="px-3 py-1.5 rounded bg-err/80 hover:bg-err text-fg text-sm flex items-center gap-1.5"
          >
            <span className="inline-block w-2.5 h-2.5 bg-white rounded-sm" />
            stop
          </button>
        ) : (
          <button
            onClick={send}
            disabled={!input.trim()}
            className="px-3 py-1.5 rounded bg-accent/80 hover:bg-accent text-fg text-sm disabled:opacity-40"
          >send</button>
        )}
      </div>
    </div>
  );
}

function MessageBubble({ msg, isLast, busy }: { msg: Msg; isLast: boolean; busy: boolean }) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="bg-accent/20 border border-accent/30 rounded px-3 py-2 max-w-[85%] whitespace-pre-wrap">{msg.content}</div>
      </div>
    );
  }
  const isStreaming = isLast && busy;
  const lastEvent = msg.events[msg.events.length - 1];
  // status line:
  //  - no events yet  → "thinking…"
  //  - last was tool_use → "calling <name>…"
  //  - last was tool_result and no text since → "processing result…"
  //  - streaming text → nothing (text bubble itself shows activity via cursor)
  let statusLabel: string | null = null;
  if (isStreaming) {
    if (msg.events.length === 0) statusLabel = "thinking";
    else {
      // find the most recent non-text event
      const lastNonText = [...msg.events].reverse().find((e) => e.type !== "text");
      const eventsAfter = lastNonText ? msg.events.indexOf(lastNonText) : -1;
      const hasTextAfter = msg.events.slice(eventsAfter + 1).some((e) => e.type === "text");
      if (!hasTextAfter && lastNonText) {
        if (lastNonText.type === "tool_use") statusLabel = `calling ${lastNonText.name}`;
        else if (lastNonText.type === "tool_result") statusLabel = "processing result";
        else if (lastNonText.type === "thinking") statusLabel = "thinking";
      }
    }
  }
  return (
    <div className="space-y-1">
      {msg.events.filter((e) => e.type === "tool_use" || e.type === "tool_result" || e.type === "error" || e.type === "flagged_events").map((e, i) => (
        <div key={i} className="text-xs mono">
          {e.type === "tool_use" && <div className="text-muted">↳ tool: <span className="text-accent2">{e.name}</span> {truncateInput(e.input)}</div>}
          {e.type === "tool_result" && <div className="text-muted">  ← result: <span className="text-muted/80">{e.output_preview?.slice(0, 100)}…</span></div>}
          {e.type === "error" && <div className="text-err">error: {e.error}</div>}
          {e.type === "flagged_events" && e.items && e.items.length > 0 && (
            <div className="mt-1 rounded border border-accent/50 bg-accent/10 px-2 py-1 space-y-0.5">
              <div className="text-accent font-semibold">★ flagged {e.items.length} event{e.items.length > 1 ? "s" : ""}</div>
              {e.items.map((f) => (
                <button
                  key={f.index}
                  onClick={() => window.dispatchEvent(new CustomEvent("stim:select-event", { detail: f.index }))}
                  className="block text-left w-full text-muted hover:text-fg truncate"
                  title={f.reason}
                >
                  <span className="text-accent mr-1">#{f.index}</span>
                  {f.reason}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
      {msg.content && (
        <div className="bg-panel2 border border-border rounded px-3 py-2">
          <Markdown>{msg.content}</Markdown>
          {isStreaming && <span className="inline-block w-1.5 h-3.5 bg-accent/70 align-middle ml-0.5 animate-pulse" />}
        </div>
      )}
      {statusLabel && (
        <div className="flex items-end gap-2 text-xs px-1 h-5">
          <Dots />
          <span className="stim-shimmer font-medium">{statusLabel}</span>
        </div>
      )}
    </div>
  );
}

function Dots() {
  return (
    <span className="inline-flex gap-1 items-end pb-0.5">
      <span className="stim-dot" style={{ animationDelay: "0ms" }} />
      <span className="stim-dot" style={{ animationDelay: "180ms" }} />
      <span className="stim-dot" style={{ animationDelay: "360ms" }} />
    </span>
  );
}

function truncateInput(input: unknown): string {
  try {
    const s = JSON.stringify(input);
    return s.length > 120 ? s.slice(0, 120) + "…" : s;
  } catch {
    return String(input).slice(0, 120);
  }
}
