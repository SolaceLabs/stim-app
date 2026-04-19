import type { Summary } from "../types";
import { AskAIHover } from "./AskAIButton";

function fmtMs(ms: number | null | undefined) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function SummaryView({ summary, onJumpToEvent }: { summary: Summary; onJumpToEvent: (i: number) => void }) {
  const d = summary.derived;
  return (
    <div className="p-5 space-y-5 max-w-5xl">
      <section>
        <div className="text-xs uppercase tracking-wider text-muted mb-1">Request</div>
        <div className="bg-panel border border-border rounded p-3 text-sm whitespace-pre-wrap">
          {summary.task.initial_request_text?.replace(/^Request received by gateway at:.*\n\n?/, "") || "(no request text)"}
        </div>
      </section>

      <section className="grid grid-cols-4 gap-3">
        <Stat label="Wall time" value={fmtMs(d.total_ms)} />
        <Stat label="LLM time" value={fmtMs(d.llm_ms)} hint={`${d.llm_pct}%`} />
        <Stat label="Tool time" value={fmtMs(d.tool_ms)} hint={`${d.tool_pct}%`} />
        <Stat label="Events / Spans" value={`${summary.event_count} / ${d.span_count}`} />
      </section>

      <section>
        <div className="text-xs uppercase tracking-wider text-muted mb-2">Per-agent tokens</div>
        <table className="w-full text-sm">
          <thead className="text-xs text-muted">
            <tr>
              <Th>Agent</Th><Th right>LLM calls</Th><Th right>Input tokens</Th><Th right>Output tokens</Th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(d.per_agent_tokens).map(([a, v]) => (
              <tr key={a} className="border-t border-border">
                <Td><span className="mono">{a}</span></Td>
                <Td right>{v.calls}</Td>
                <Td right>{v.input.toLocaleString()}</Td>
                <Td right>{v.output.toLocaleString()}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <div className="text-xs uppercase tracking-wider text-muted mb-2">Slowest spans</div>
        <table className="w-full text-sm">
          <thead className="text-xs text-muted">
            <tr>
              <Th>#</Th><Th>Type</Th><Th>Agent</Th><Th>Name/Model</Th>
              <Th right>Duration</Th><Th right>Start</Th><Th right>In tok</Th><Th right>Out tok</Th><Th right>Size</Th>
            </tr>
          </thead>
          <tbody>
            {d.slowest_spans.map((s, i) => (
              <AskAIHover
                as="tr"
                key={i}
                context={`Span · ${s.type}${s.agent ? ` · agent=${s.agent}` : ""}${s.type === "llm" ? ` · model=${s.model}` : ` · tool=${s.tool_name}`} · duration=${fmtMs(s.duration_ms)} · start event #${s.start_event}`}
                placeholder="Ask about this span…"
                className="border-t border-border hover:bg-panel2 cursor-pointer"
                onClick={() => onJumpToEvent(s.start_event)}
              >
                <Td className="text-muted">{i + 1}</Td>
                <Td>
                  <span className={s.type === "llm" ? "text-accent" : "text-accent2"}>{s.type}</span>
                </Td>
                <Td><span className="mono text-xs">{s.agent || "—"}</span></Td>
                <Td><span className="mono text-xs">{s.type === "llm" ? s.model : s.tool_name}</span></Td>
                <Td right className="font-semibold">{fmtMs(s.duration_ms)}</Td>
                <Td right className="text-muted">{fmtMs(s.start_ms)}</Td>
                <Td right>{s.input_tokens?.toLocaleString() || "—"}</Td>
                <Td right>{s.output_tokens?.toLocaleString() || "—"}</Td>
                <Td right className="text-muted">{s.result_size != null ? `${(s.result_size / 1024).toFixed(1)}KB` : "—"}</Td>
              </AskAIHover>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-panel border border-border rounded p-3">
      <div className="text-xs uppercase tracking-wider text-muted">{label}</div>
      <div className="text-xl mt-1 font-semibold">{value}</div>
      {hint && <div className="text-xs text-muted">{hint}</div>}
    </div>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={`py-2 px-2 font-normal ${right ? "text-right" : "text-left"}`}>{children}</th>;
}
function Td({ children, right, className = "" }: { children: React.ReactNode; right?: boolean; className?: string }) {
  return <td className={`py-2 px-2 ${right ? "text-right" : ""} ${className}`}>{children}</td>;
}
