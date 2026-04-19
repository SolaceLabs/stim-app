import { useEffect, useRef, useState } from "react";
import {
  assignFile,
  createProject,
  deleteFile,
  deleteProject,
  listProjects,
  renameProject,
  uploadFile,
  type Project,
} from "../api";

const COLLAPSE_KEY = "stim-app.project_collapsed";
const PIN_KEY = "stim-app.pinned_files";
const RECENT_KEY = "stim-app.recent_files";
const RECENT_MAX = 12;

type FileT = { id: string; filename: string; project_id?: string | null };

export function FileBrowser({
  files, activeId, onSelect, onRefresh,
}: {
  files: FileT[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsOpen, setProjectsOpen] = useState<boolean>(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "[]")); }
    catch { return new Set(); }
  });
  const [pinned, setPinned] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(PIN_KEY) || "[]")); }
    catch { return new Set(); }
  });
  const [recents, setRecents] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); }
    catch { return []; }
  });
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  useEffect(() => {
    listProjects().then(setProjects).catch(() => setProjects([]));
  }, [files]);

  useEffect(() => { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed])); }, [collapsed]);
  useEffect(() => { localStorage.setItem(PIN_KEY, JSON.stringify([...pinned])); }, [pinned]);
  useEffect(() => { localStorage.setItem(RECENT_KEY, JSON.stringify(recents)); }, [recents]);

  // Track recents when user selects a file.
  useEffect(() => {
    if (!activeId) return;
    setRecents((cur) => {
      const next = [activeId, ...cur.filter((x) => x !== activeId)].slice(0, RECENT_MAX);
      return next;
    });
  }, [activeId]);

  // Prune missing files from pinned/recents.
  useEffect(() => {
    const ids = new Set(files.map((f) => f.id));
    setPinned((cur) => {
      const next = new Set([...cur].filter((x) => ids.has(x)));
      return next.size === cur.size ? cur : next;
    });
    setRecents((cur) => {
      const next = cur.filter((x) => ids.has(x));
      return next.length === cur.length ? cur : next;
    });
  }, [files]);

  function togglePin(id: string) {
    setPinned((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleCollapse(pid: string) {
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(pid)) next.delete(pid); else next.add(pid);
      return next;
    });
  }

  async function handleFiles(fs: FileList | null) {
    if (!fs || fs.length === 0) return;
    setBusy(true); setErr(null);
    try {
      for (const f of Array.from(fs)) {
        const s = await uploadFile(f);
        onSelect(s.id);
      }
      onRefresh();
    } catch (e: any) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateProject() {
    const name = newName.trim();
    if (!name) { setCreating(false); return; }
    try {
      await createProject(name);
      setProjects(await listProjects());
      setNewName("");
      setCreating(false);
    } catch (e: any) { setErr(e.message); }
  }

  async function handleRename(p: Project) {
    const name = prompt("Rename project", p.name);
    if (!name || name.trim() === p.name) return;
    try {
      await renameProject(p.id, name.trim());
      setProjects(await listProjects());
    } catch (e: any) { setErr(e.message); }
  }

  async function handleDeleteProject(p: Project) {
    if (!confirm(`Delete project "${p.name}"? Files inside will become unassigned.`)) return;
    try { await deleteProject(p.id); onRefresh(); }
    catch (e: any) { setErr(e.message); }
  }

  async function handleAssign(fileId: string, projectId: string | null) {
    try { await assignFile(fileId, projectId); onRefresh(); }
    catch (e: any) { setErr(e.message); }
  }

  const byId = new Map(files.map((f) => [f.id, f]));
  const pinnedFiles = [...pinned].map((id) => byId.get(id)).filter((f): f is FileT => !!f);
  const recentFiles = recents.map((id) => byId.get(id)).filter((f): f is FileT => !!f && !pinned.has(f.id));
  // Files that aren't in any project and haven't surfaced in recents — fallback list.
  const others = files.filter(
    (f) => !f.project_id && !pinned.has(f.id) && !recents.includes(f.id),
  );

  return (
    <div
      className="p-2 space-y-1 h-full flex flex-col"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); handleFiles(e.dataTransfer.files); }}
    >
      <SidebarAction
        icon={<PlusIcon />}
        label={busy ? "uploading…" : "Upload .stim"}
        onClick={() => inputRef.current?.click()}
      />
      <input
        ref={inputRef}
        type="file"
        accept=".stim,.yaml,.yml"
        multiple
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />

      <SidebarAction
        icon={<FolderIcon />}
        label="Projects"
        trailing={
          <div className="flex items-center gap-1">
            <button
              className="text-accent hover:text-fg"
              onClick={(e) => { e.stopPropagation(); setCreating(true); setNewName(""); }}
              title="New project"
            >+</button>
            <span className="text-muted">{projectsOpen ? "▾" : "▸"}</span>
          </div>
        }
        onClick={() => setProjectsOpen((v) => !v)}
      />

      {err && <div className="text-xs text-err px-2">{err}</div>}

      {projectsOpen && (
        <div className="pl-2 space-y-0.5">
          {creating && (
            <div className="flex gap-1 py-1">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateProject();
                  if (e.key === "Escape") { setCreating(false); setNewName(""); }
                }}
                placeholder="Project name"
                className="flex-1 bg-panel2 border border-border rounded px-2 py-1 text-xs"
              />
              <button onClick={handleCreateProject} className="text-xs px-2 rounded bg-accent text-white">ok</button>
            </div>
          )}
          {projects.length === 0 && !creating && (
            <div className="text-[11px] text-muted italic px-2 py-1">No projects yet</div>
          )}
          {projects.map((p) => {
            const items = files.filter((f) => f.project_id === p.id);
            const isCollapsed = collapsed.has(p.id);
            return (
              <div key={p.id}>
                <div
                  className="group flex items-center gap-1 px-2 py-1 rounded text-xs cursor-pointer hover:bg-panel2"
                  onClick={() => toggleCollapse(p.id)}
                >
                  <span className="text-muted w-3">{isCollapsed ? "▸" : "▾"}</span>
                  <span className="flex-1 truncate">{p.name}</span>
                  <span className="text-muted">{items.length}</span>
                  <button className="opacity-0 group-hover:opacity-100 text-muted hover:text-fg px-1"
                    onClick={(e) => { e.stopPropagation(); handleRename(p); }} title="Rename">✎</button>
                  <button className="opacity-0 group-hover:opacity-100 text-err px-1"
                    onClick={(e) => { e.stopPropagation(); handleDeleteProject(p); }} title="Delete">×</button>
                </div>
                {!isCollapsed && (
                  <div className="ml-4 space-y-0.5">
                    {items.length === 0 && <div className="text-[11px] text-muted italic px-2">empty</div>}
                    {items.map((f) => (
                      <FileRow
                        key={f.id}
                        file={f}
                        active={activeId === f.id}
                        pinned={pinned.has(f.id)}
                        onSelect={onSelect}
                        onRefresh={onRefresh}
                        projects={projects}
                        onAssign={handleAssign}
                        onTogglePin={togglePin}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <SectionHeader>Pinned</SectionHeader>
      <div className="space-y-0.5">
        {pinnedFiles.length === 0 && (
          <div className="text-[11px] text-muted italic px-2 py-1">
            <PinIcon /> <span className="ml-1">Hover a file and pin it</span>
          </div>
        )}
        {pinnedFiles.map((f) => (
          <FileRow
            key={f.id}
            file={f}
            active={activeId === f.id}
            pinned
            onSelect={onSelect}
            onRefresh={onRefresh}
            projects={projects}
            onAssign={handleAssign}
            onTogglePin={togglePin}
          />
        ))}
      </div>

      <SectionHeader>Recents</SectionHeader>
      <div className="space-y-0.5 flex-1 overflow-auto">
        {recentFiles.length === 0 && others.length === 0 && (
          <div className="text-[11px] text-muted italic px-2 py-1">No traces yet</div>
        )}
        {recentFiles.map((f) => (
          <FileRow
            key={f.id}
            file={f}
            active={activeId === f.id}
            pinned={false}
            onSelect={onSelect}
            onRefresh={onRefresh}
            projects={projects}
            onAssign={handleAssign}
            onTogglePin={togglePin}
          />
        ))}
        {others.length > 0 && (
          <>
            <div className="pt-2 text-[10px] uppercase tracking-wider text-muted px-2">Older</div>
            {others.map((f) => (
              <FileRow
                key={f.id}
                file={f}
                active={activeId === f.id}
                pinned={false}
                onSelect={onSelect}
                onRefresh={onRefresh}
                projects={projects}
                onAssign={handleAssign}
                onTogglePin={togglePin}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] text-muted px-2 pt-3 pb-0.5">{children}</div>;
}

function SidebarAction({
  icon, label, onClick, trailing,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  trailing?: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-fg hover:bg-panel2"
    >
      <span className="text-muted">{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {trailing}
    </button>
  );
}

function PlusIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>;
}
function FolderIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>;
}
function PinIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" className="inline-block">
      <path d="M12 17v5M8 3h8l-1 5 3 3-1 2H9l-1-2 3-3-1-5z"/>
    </svg>
  );
}

function FileRow({
  file, active, pinned, onSelect, onRefresh, projects, onAssign, onTogglePin,
}: {
  file: FileT;
  active: boolean;
  pinned: boolean;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  projects: Project[];
  onAssign: (fileId: string, projectId: string | null) => void;
  onTogglePin: (id: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  return (
    <div
      className={`group flex items-center gap-1 px-2 py-1 rounded cursor-pointer text-sm relative ${
        active ? "bg-panel2 text-fg" : "hover:bg-panel2 text-fg/90"
      }`}
      onClick={() => onSelect(file.id)}
    >
      <span className="truncate flex-1">{file.filename}</span>
      <button
        className={`${pinned ? "text-accent" : "opacity-0 group-hover:opacity-100 text-muted hover:text-fg"} px-1`}
        onClick={(e) => { e.stopPropagation(); onTogglePin(file.id); }}
        title={pinned ? "Unpin" : "Pin"}
      ><PinIcon filled={pinned} /></button>
      <button
        className="opacity-0 group-hover:opacity-100 text-muted hover:text-fg px-1"
        onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
        title="Move to project"
      >⋯</button>
      <button
        className="opacity-0 group-hover:opacity-100 text-err px-1"
        onClick={async (e) => {
          e.stopPropagation();
          await deleteFile(file.id);
          onRefresh();
          if (active) onSelect("");
        }}
        title="remove"
      >×</button>
      {menuOpen && (
        <div
          ref={menuRef}
          className="absolute z-20 top-full right-0 mt-1 bg-panel border border-border rounded shadow-lg py-1 min-w-[140px] text-xs"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-[10px] text-muted uppercase px-2 pb-1">Move to</div>
          <button
            className={`block w-full text-left px-2 py-1 hover:bg-panel2 ${!file.project_id ? "text-accent" : ""}`}
            onClick={() => { onAssign(file.id, null); setMenuOpen(false); }}
          >— unassigned</button>
          {projects.map((p) => (
            <button
              key={p.id}
              className={`block w-full text-left px-2 py-1 hover:bg-panel2 truncate ${file.project_id === p.id ? "text-accent" : ""}`}
              onClick={() => { onAssign(file.id, p.id); setMenuOpen(false); }}
            >{p.name}</button>
          ))}
          {projects.length === 0 && (
            <div className="text-[11px] text-muted px-2 italic">no projects</div>
          )}
        </div>
      )}
    </div>
  );
}
