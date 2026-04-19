import { useEffect, useMemo, useState } from "react";
import { getSpans } from "../api";
import type { Span, Summary } from "../types";

const ROW_H = 22;
const ROW_GAP = 2;
const LANE_GAP = 10;
const HEADER_H = 30;
const LABEL_W = 130;

function packRows(spans: Span[]): Span[][] {
  // Greedy: each span goes into the first row whose last span ends before this starts.
  const rows: Span[][] = [];
  const sorted = [...spans].sort((a, b) => a.start_ms - b.start_ms);
  for (const s of sorted) {
    let placed = false;
    for (const row of rows) {
      if (row[row.length - 1].end_ms <= s.start_ms) {
        row.push(s);
        placed = true;
        break;
      }
    }
    if (!placed) rows.push([s]);
  }
  return rows;
}

export function TimelineView({ fileId, summary }: { fileId: string; summary: Summary }) {
  const [spans, setSpans] = useState<Span[]>([]);
  const [hovered, setHovered] = useState<Span | null>(null);

  useEffect(() => { getSpans(fileId).then(setSpans); }, [fileId]);

  const total = summary.derived.total_ms || 1;

  const lanes = useMemo(() => {
    const byAgent = new Map<string, Span[]>();
    for (const s of spans) {
      const key = s.agent || "?";
      if (!byAgent.has(key)) byAgent.set(key, []);
      byAgent.get(key)!.push(s);
    }
    return Array.from(byAgent.entries()).map(([agent, agentSpans]) => ({
      agent,
      rows: packRows(agentSpans),
    }));
  }, [spans]);

  const trackWidth = 1200;
  const width = LABEL_W + trackWidth;
  const pxPerMs = trackWidth / total;

  // compute y positions
  let cursorY = HEADER_H;
  const laneBounds = lanes.map((l) => {
    const height = l.rows.length * (ROW_H + ROW_GAP);
    const y = cursorY;
    cursorY += height + LANE_GAP;
    return { y, height };
  });
  const height = cursorY + 10;

  return (
    <div className="p-5">
      <div className="text-xs uppercase tracking-wider text-muted mb-2">Timeline</div>
      <div className="bg-panel border border-border rounded p-3 overflow-x-auto">
        <div className="relative mono text-xs" style={{ width, height }}>
          {/* axis ticks */}
          {[0, 0.25, 0.5, 0.75, 1].map((f) => {
            const x = LABEL_W + f * trackWidth;
            const t = f * total;
            return (
              <div key={f}>
                <div className="absolute text-muted" style={{ left: x, top: 0 }}>{(t / 1000).toFixed(1)}s</div>
                <div className="absolute w-px bg-border/70" style={{ left: x, top: 16, height: height - 16 }} />
              </div>
            );
          })}
          {/* vertical separator between labels and track */}
          <div className="absolute w-px bg-border" style={{ left: LABEL_W - 1, top: 0, height }} />

          {/* lanes */}
          {lanes.map((lane, li) => {
            const { y, height: lh } = laneBounds[li];
            return (
              <div key={lane.agent}>
                {/* lane background band for visual separation */}
                <div
                  className="absolute bg-panel2/40"
                  style={{ left: 0, top: y - 2, width, height: lh + 4 }}
                />
                <div
                  className="absolute text-fg/90 truncate"
                  style={{ left: 6, top: y + 4, width: LABEL_W - 12 }}
                  title={lane.agent}
                >
                  {lane.agent}
                </div>
                {lane.rows.map((row, ri) =>
                  row.map((s, si) => {
                    const left = LABEL_W + s.start_ms * pxPerMs;
                    const w = Math.max(3, s.duration_ms * pxPerMs);
                    const top = y + ri * (ROW_H + ROW_GAP);
                    const color = s.type === "llm" ? "bg-accent/80 hover:bg-accent border-accent/40" : "bg-accent2/80 hover:bg-accent2 border-accent2/40";
                    const label = s.type === "llm"
                      ? `${s.output_tokens ?? "?"} out · ${(s.duration_ms / 1000).toFixed(1)}s`
                      : `${s.tool_name} · ${(s.duration_ms / 1000).toFixed(1)}s`;
                    return (
                      <div
                        key={`${ri}-${si}`}
                        className={`absolute rounded border ${color} cursor-pointer overflow-hidden`}
                        style={{ left, width: w, top, height: ROW_H }}
                        onMouseEnter={() => setHovered(s)}
                        onMouseLeave={() => setHovered((h) => (h === s ? null : h))}
                        title={`${s.type === "llm" ? s.model : s.tool_name} — ${(s.duration_ms / 1000).toFixed(2)}s`}
                      >
                        <div className="text-[10px] text-fg truncate px-1.5 leading-[20px]">
                          {label}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="mt-3 text-xs text-muted flex gap-4 sticky bottom-0 bg-bg py-2">
        <span><span className="inline-block w-3 h-3 bg-accent rounded mr-1 align-middle" />LLM call</span>
        <span><span className="inline-block w-3 h-3 bg-accent2 rounded mr-1 align-middle" />Tool call</span>
        <span className="text-muted/70 ml-auto">hover a bar for details</span>
      </div>
      {hovered && (
        <div className="mt-2 bg-panel2 border border-border rounded p-3 text-xs">
          <div className="font-semibold mb-1">
            {hovered.type === "llm" ? `LLM call · ${hovered.model}` : `Tool · ${hovered.tool_name}`}
          </div>
          <div className="grid grid-cols-4 gap-2 text-muted">
            <div><div>Agent</div><div className="text-fg mono">{hovered.agent}</div></div>
            <div><div>Duration</div><div className="text-fg">{(hovered.duration_ms / 1000).toFixed(2)}s</div></div>
            <div><div>Start</div><div className="text-fg">{(hovered.start_ms / 1000).toFixed(2)}s</div></div>
            {hovered.type === "llm" ? (
              <div><div>Tokens</div><div className="text-fg">{hovered.input_tokens} / {hovered.output_tokens}</div></div>
            ) : (
              <div><div>Result size</div><div className="text-fg">{hovered.result_size ? `${(hovered.result_size / 1024).toFixed(1)} KB` : "—"}</div></div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
