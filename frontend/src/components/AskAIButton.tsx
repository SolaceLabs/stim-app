import { useEffect, useRef, useState } from "react";

/**
 * Click-triggered Ask AI popover anchored to the trigger element.
 * Dispatches `stim:ask-ai` with { context, question } on submit.
 */
function AskAIPopoverShell({
  context,
  placeholder,
  onClose,
  anchorRect,
}: {
  context: string;
  placeholder: string;
  onClose: () => void;
  anchorRect: DOMRect;
}) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  function submit() {
    const q = text.trim();
    if (!q) return;
    window.dispatchEvent(new CustomEvent("stim:open-chat"));
    window.dispatchEvent(new CustomEvent("stim:ask-ai", { detail: { context, question: q } }));
    onClose();
  }

  const POP_W = 380;
  const left = Math.max(8, Math.min(window.innerWidth - POP_W - 8, anchorRect.right - POP_W));
  const top = anchorRect.bottom + 4;

  return (
    <div
      ref={rootRef}
      style={{ position: "fixed", left, top, zIndex: 50, width: POP_W }}
      className="flex items-center gap-1 bg-panel border border-accent/50 rounded shadow-lg p-1.5"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="text-[10px] text-accent px-1 whitespace-nowrap">Ask AI</span>
      <input
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
        placeholder={placeholder}
        className="flex-1 bg-panel2 border border-border rounded px-2 py-0.5 text-xs"
      />
      <button
        onClick={submit}
        disabled={!text.trim()}
        className="text-xs px-2 py-0.5 rounded bg-accent text-white disabled:opacity-40"
      >send</button>
    </div>
  );
}

/**
 * Wraps a row/element. Clicking the row opens the Ask AI popover anchored
 * below it (while still firing any parent `onClick` if provided — note: we
 * fire the click BEFORE opening, so selection/navigation still happens).
 *
 * Pass `trigger="icon"` to render a small click target cell instead of
 * taking over the whole row click.
 */
export function AskAIHover({
  context,
  placeholder = "Ask about this…",
  children,
  as: Tag = "div",
  className = "",
  onClick,
  ...rest
}: {
  context: string;
  placeholder?: string;
  children: React.ReactNode;
  as?: any;
  className?: string;
  onClick?: (e: React.MouseEvent) => void;
  [k: string]: any;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  return (
    <>
      <Tag
        {...rest}
        className={className}
        onClick={(e: React.MouseEvent) => {
          onClick?.(e);
          if (e.defaultPrevented) return;
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setAnchor(rect);
        }}
      >
        {children}
      </Tag>
      {anchor && (
        <AskAIPopoverShell
          context={context}
          placeholder={placeholder}
          anchorRect={anchor}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  );
}

/** Standalone button variant for toolbars / headers. */
export function AskAIButton({
  context,
  placeholder = "Ask about this…",
  className = "",
}: {
  context: string;
  placeholder?: string;
  className?: string;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  return (
    <>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect());
        }}
        className={`text-xs px-2 py-0.5 rounded border border-accent/50 text-accent hover:bg-accent/10 ${className}`}
      >Ask AI</button>
      {anchor && (
        <AskAIPopoverShell
          context={context}
          placeholder={placeholder}
          anchorRect={anchor}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  );
}
