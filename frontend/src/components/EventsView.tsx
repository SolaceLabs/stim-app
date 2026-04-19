import { useEffect, useMemo, useState } from "react";
import { getEvent, getEvents } from "../api";
import type { FlaggedEvent } from "../api";
import type { EventRow } from "../types";
import { JsonView } from "./JsonView";
import { AskAIButton, AskAIHover } from "./AskAIButton";

const KIND_COLORS: Record<string, string> = {
  llm_request: "text-accent",
  llm_response: "text-accent",
  tool_call: "text-accent2",
  tool_result: "text-accent2",
  peer_request: "text-warn",
  peer_response: "text-warn",
  status_text: "text-muted",
  other: "text-muted",
};

export function EventsView({ fileId }: { fileId: string }) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [filter, setFilter] = useState("");
  const [kindFilter, setKindFilter] = useState<string>("");
  const [flags, setFlags] = useState<Map<number, FlaggedEvent>>(new Map());

  useEffect(() => {
    const handler = (ev: Event) => {
      const items = (ev as CustomEvent<FlaggedEvent[]>).detail || [];
      setFlags(new Map(items.map((f) => [f.index, f])));
    };
    window.addEventListener("stim:flag-events", handler as EventListener);
    return () => window.removeEventListener("stim:flag-events", handler as EventListener);
  }, []);

  // Reset flags when switching traces.
  useEffect(() => { setFlags(new Map()); }, [fileId]);

  useEffect(() => {
    getEvents(fileId).then((e) => { setEvents(e); setSelected(e[0]?.index ?? null); });
  }, [fileId]);

  useEffect(() => {
    const handler = (ev: Event) => setSelected((ev as CustomEvent<number>).detail);
    window.addEventListener("stim:select-event", handler as EventListener);
    return () => window.removeEventListener("stim:select-event", handler as EventListener);
  }, []);

  useEffect(() => {
    if (selected == null) { setDetail(null); return; }
    getEvent(fileId, selected).then(setDetail);
  }, [fileId, selected]);

  const filtered = useMemo(() => {
    const lf = filter.toLowerCase();
    return events.filter((e) => {
      if (kindFilter && e.kind !== kindFilter) return false;
      if (!lf) return true;
      const blob = `${e.agent} ${e.kind} ${e.tool_name || ""} ${e.text || ""} ${e.status_text || ""}`.toLowerCase();
      return blob.includes(lf);
    });
  }, [events, filter, kindFilter]);

  const kinds = Array.from(new Set(events.map((e) => e.kind)));

  return (
    <div className="flex h-full">
      <div className="w-1/2 border-r border-border flex flex-col">
        <div className="flex gap-2 p-2 border-b border-border bg-panel">
          <input
            placeholder="search text, tool, agent…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="flex-1 bg-panel2 border border-border rounded px-2 py-1 text-xs"
          />
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value)}
            className="bg-panel2 border border-border rounded px-2 py-1 text-xs"
          >
            <option value="">all kinds</option>
            {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>
        <div className="flex-1 overflow-auto mono text-xs">
          <table className="w-full">
            <thead className="sticky top-0 bg-panel text-muted">
              <tr>
                <th className="text-right px-2 py-1">#</th>
                <th className="text-right px-2 py-1">t</th>
                <th className="text-left px-2 py-1">agent</th>
                <th className="text-left px-2 py-1">kind</th>
                <th className="text-left px-2 py-1">detail</th>
                <th className="text-right px-2 py-1">tok</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => {
                const flag = flags.get(e.index);
                const sev = flag?.severity || "info";
                const flagRing =
                  sev === "error" ? "ring-1 ring-err/70"
                  : sev === "warn" ? "ring-1 ring-warn/70"
                  : "ring-1 ring-accent/60";
                return (
                  <AskAIHover
                    as="tr"
                    key={e.index}
                    title={flag?.reason}
                    context={`Event #${e.index} · ${e.kind}${e.agent ? ` · agent=${e.agent}` : ""}${e.tool_name ? ` · tool=${e.tool_name}` : ""}`}
                    placeholder={`Ask about event #${e.index}…`}
                    className={`border-t border-border cursor-pointer ${selected === e.index ? "bg-panel2" : "hover:bg-panel2/50"} ${flag ? flagRing : ""}`}
                    onClick={() => setSelected(e.index)}
                  >
                    <td className="text-right px-2 py-1 text-muted">
                      {flag && <span className="mr-1" aria-label="flagged">★</span>}
                      {e.index}
                    </td>
                    <td className="text-right px-2 py-1 text-muted">{(e.t_offset_ms / 1000).toFixed(2)}s</td>
                    <td className="px-2 py-1">{e.agent || "—"}</td>
                    <td className={`px-2 py-1 ${KIND_COLORS[e.kind] || ""}`}>{e.kind}</td>
                    <td className="px-2 py-1 truncate max-w-[240px]">
                      {flag?.reason || e.tool_name || e.status_text || e.text?.slice(0, 80) || ""}
                    </td>
                    <td className="text-right px-2 py-1 text-muted">
                      {e.input_tokens ? `${e.input_tokens}/${e.output_tokens ?? ""}` : ""}
                    </td>
                  </AskAIHover>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div className="w-1/2 overflow-auto">
        {detail ? (
          <EventInspector detail={detail} flag={flags.get(detail.index)} />
        ) : (
          <div className="p-5 text-muted text-sm">select an event</div>
        )}
      </div>
    </div>
  );
}

function EventInspector({ detail, flag }: { detail: any; flag?: FlaggedEvent }) {
  const sev = flag?.severity || "info";
  const flagBg =
    sev === "error" ? "border-err/60 bg-err/10"
    : sev === "warn" ? "border-warn/60 bg-warn/10"
    : "border-accent/60 bg-accent/10";
  return (
    <div className="p-4 space-y-3 text-xs">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="text-lg font-semibold">Event #{detail.index}</div>
        <div className={`mono ${KIND_COLORS[detail.kind] || ""}`}>{detail.kind}</div>
        <div className="text-muted">at {(detail.t_offset_ms / 1000).toFixed(3)}s</div>
        <div className="flex-1" />
        <AskAIButton
          context={buildEventContext(detail)}
          placeholder={`Ask AI about event #${detail.index}…`}
        />
      </div>
      {flag && (
        <div className={`border rounded px-3 py-2 text-sm ${flagBg}`}>
          <span className="mr-2">★</span>
          <span className="text-muted mr-1">AI flagged:</span>
          {flag.reason}
        </div>
      )}
      <KV k="agent" v={detail.agent} />
      <KV k="topic" v={detail.topic} mono />
      <KV k="direction" v={detail.direction} />
      {detail.model && <KV k="model" v={detail.model} mono />}
      {(detail.input_tokens || detail.output_tokens) && (
        <KV k="tokens" v={`${detail.input_tokens ?? "—"} in / ${detail.output_tokens ?? "—"} out`} />
      )}
      {detail.tool_name && <KV k="tool" v={detail.tool_name} mono />}
      {detail.tool_args && (
        <details className="border border-border rounded" open>
          <summary className="px-2 py-1 cursor-pointer bg-panel2">tool_args</summary>
          <div className="p-2 overflow-auto max-h-80">
            <JsonView value={detail.tool_args} collapsed={3} />
          </div>
        </details>
      )}
      {detail.tool_result_preview && (
        <details className="border border-border rounded">
          <summary className="px-2 py-1 cursor-pointer bg-panel2">
            tool_result_preview {detail.tool_result_size && <span className="text-muted">({(detail.tool_result_size / 1024).toFixed(1)} KB)</span>}
          </summary>
          <pre className="p-2 overflow-auto mono max-h-80">{detail.tool_result_preview}</pre>
        </details>
      )}
      {detail.text && (
        <details className="border border-border rounded" open>
          <summary className="px-2 py-1 cursor-pointer bg-panel2">text</summary>
          <pre className="p-2 overflow-auto whitespace-pre-wrap max-h-80">{detail.text}</pre>
        </details>
      )}
      <details className="border border-border rounded">
        <summary className="px-2 py-1 cursor-pointer bg-panel2">raw payload</summary>
        <div className="p-2 overflow-auto max-h-[500px]">
          <JsonView value={detail.payload} collapsed={2} />
        </div>
      </details>
    </div>
  );
}

function buildEventContext(detail: any): string {
  const parts = [
    `Event #${detail.index}`,
    `kind=${detail.kind}`,
    `agent=${detail.agent ?? "—"}`,
    `t=${(detail.t_offset_ms / 1000).toFixed(3)}s`,
  ];
  if (detail.tool_name) parts.push(`tool=${detail.tool_name}`);
  if (detail.model) parts.push(`model=${detail.model}`);
  if (detail.input_tokens || detail.output_tokens)
    parts.push(`tokens=${detail.input_tokens ?? "—"}/${detail.output_tokens ?? "—"}`);
  return parts.join(" · ");
}

function KV({ k, v, mono }: { k: string; v: any; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <div className="text-muted w-24">{k}</div>
      <div className={mono ? "mono break-all" : "break-all"}>{String(v)}</div>
    </div>
  );
}
