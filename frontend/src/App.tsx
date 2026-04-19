import { useEffect, useRef, useState } from "react";
import { FileBrowser } from "./components/FileBrowser";
import { SummaryView } from "./components/SummaryView";
import { TimelineView } from "./components/TimelineView";
import { EventsView } from "./components/EventsView";
import { ChatPanel } from "./components/ChatPanel";
import type { Summary } from "./types";
import { getSummary, listFiles } from "./api";
import { useAuth } from "./auth/AuthProvider";

type Tab = "summary" | "timeline" | "events";

export default function App() {
  const { user, signOut } = useAuth();
  const [fileId, setFileId] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [tab, setTab] = useState<Tab>("summary");
  const [refreshKey, setRefreshKey] = useState(0);
  const [files, setFiles] = useState<{ id: string; filename: string; project_id?: string | null }[]>([]);
  const [chatOpen, setChatOpen] = useState(true);
  const [theme, setTheme] = useState<"dark" | "light">(
    () => (localStorage.getItem("stim-app.theme") === "light" ? "light" : "dark")
  );
  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
    localStorage.setItem("stim-app.theme", theme);
  }, [theme]);

  useEffect(() => {
    const handler = () => setChatOpen(true);
    window.addEventListener("stim:open-chat", handler);
    return () => window.removeEventListener("stim:open-chat", handler);
  }, []);
  const [chatWidth, setChatWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem("stim-app.chat_width") || 420);
    return Number.isFinite(v) && v >= 280 ? v : 420;
  });
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  useEffect(() => {
    localStorage.setItem("stim-app.chat_width", String(chatWidth));
  }, [chatWidth]);

  function onDragStart(e: React.MouseEvent) {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: chatWidth };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const maxW = Math.floor(window.innerWidth * 0.7); // up to 70%
      const minW = 280;
      const next = dragRef.current.startW + (dragRef.current.startX - ev.clientX);
      setChatWidth(Math.max(minW, Math.min(maxW, next)));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  useEffect(() => {
    listFiles().then((fs) => setFiles(fs.map((f) => ({ id: f.id, filename: f.filename, project_id: f.project_id }))));
  }, [refreshKey]);

  useEffect(() => {
    if (!fileId) { setSummary(null); return; }
    getSummary(fileId).then(setSummary).catch(() => setSummary(null));
  }, [fileId]);

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-center gap-4 px-4 h-12 border-b border-border bg-panel">
        <div className="font-semibold tracking-tight">stim<span className="text-accent">·</span>explorer</div>
        <div className="text-muted text-xs">SAM trace diagnostics</div>
        <div className="flex-1" />
        <div className="flex text-xs rounded border border-border overflow-hidden">
          <button
            onClick={() => setTheme("dark")}
            aria-pressed={theme === "dark"}
            title="Dark theme"
            className={`px-2.5 py-1 font-medium ${theme === "dark" ? "bg-accent text-white shadow-inner" : "text-muted hover:bg-panel2"}`}
          >☾ dark</button>
          <button
            onClick={() => setTheme("light")}
            aria-pressed={theme === "light"}
            title="Light theme"
            className={`px-2.5 py-1 font-medium border-l border-border ${theme === "light" ? "bg-accent text-white shadow-inner" : "text-muted hover:bg-panel2"}`}
          >☀ light</button>
        </div>
        <button
          className="text-xs px-2 py-1 rounded border border-border hover:bg-panel2"
          onClick={() => setChatOpen((v) => !v)}
        >
          {chatOpen ? "hide chat" : "show chat"}
        </button>
        {user && (
          <div className="flex items-center gap-2 pl-2 border-l border-border">
            <div className="text-xs" title={user.email || user.sub}>
              <div className="text-fg">{user.name || user.email || "user"}</div>
            </div>
            <button
              className="text-xs px-2 py-1 rounded border border-border hover:bg-panel2"
              onClick={signOut}
              title="Sign out"
            >sign out</button>
          </div>
        )}
      </header>
      <div className="flex-1 flex overflow-hidden">
        <aside className="w-64 border-r border-border bg-panel overflow-y-auto">
          <FileBrowser
            files={files}
            activeId={fileId}
            onSelect={(id) => setFileId(id || null)}
            onRefresh={() => setRefreshKey((k) => k + 1)}
          />
        </aside>
        <main className="flex-1 flex flex-col overflow-hidden">
          {summary ? (
            <>
              <div className="flex items-center gap-1 px-3 pt-2 border-b border-border bg-panel">
                {(["summary", "timeline", "events"] as Tab[]).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`px-3 py-1.5 text-xs rounded-t ${
                      tab === t ? "bg-bg text-fg border-x border-t border-border" : "text-muted hover:text-fg"
                    }`}
                  >
                    {t}
                  </button>
                ))}
                <div className="flex-1" />
                <div className="text-xs text-muted pr-2 mono">{summary.filename}</div>
              </div>
              <div className="flex-1 overflow-auto">
                {tab === "summary" && <SummaryView summary={summary} onJumpToEvent={(i) => { setTab("events"); setTimeout(() => window.dispatchEvent(new CustomEvent("stim:select-event", { detail: i })), 50); }} />}
                {tab === "timeline" && <TimelineView fileId={fileId!} summary={summary} />}
                {tab === "events" && <EventsView fileId={fileId!} />}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted">
              <div className="text-center">
                <div className="text-lg mb-2">No trace selected</div>
                <div className="text-xs">Upload a .stim file or pick one from the sidebar.</div>
              </div>
            </div>
          )}
        </main>
        {chatOpen && fileId && (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              onMouseDown={onDragStart}
              onDoubleClick={() => setChatWidth(420)}
              title="Drag to resize · double-click to reset"
              className="w-1 cursor-col-resize hover:bg-accent/40 active:bg-accent/60 border-l border-border flex-shrink-0"
            />
            <aside
              style={{ width: chatWidth }}
              className="border-l border-border bg-panel flex flex-col overflow-hidden flex-shrink-0"
            >
              <ChatPanel fileId={fileId} />
            </aside>
          </>
        )}
      </div>
    </div>
  );
}
