import JsonViewCore from "@uiw/react-json-view";

// Tokens are now rgb-triplet vars; wrap with rgb() for direct CSS consumption.
const rgb = (v: string) => `rgb(var(${v}))`;
const themeStyle = {
  "--w-rjv-font-family": '"JetBrains Mono", Menlo, monospace',
  "--w-rjv-color": rgb("--c-fg"),
  "--w-rjv-background-color": rgb("--c-bg"),
  "--w-rjv-line-color": rgb("--c-border"),
  "--w-rjv-arrow-color": rgb("--c-muted"),
  "--w-rjv-edit-color": rgb("--c-fg"),
  "--w-rjv-info-color": rgb("--c-muted"),
  "--w-rjv-update-color": rgb("--c-accent2"),
  "--w-rjv-copied-color": rgb("--c-ok"),
  "--w-rjv-copied-success-color": rgb("--c-ok"),
  "--w-rjv-curlybraces-color": rgb("--c-accent2"),
  "--w-rjv-colon-color": rgb("--c-muted"),
  "--w-rjv-brackets-color": rgb("--c-accent2"),
  "--w-rjv-ellipsis-color": rgb("--c-warn"),
  "--w-rjv-quotes-color": rgb("--c-ok"),
  "--w-rjv-quotes-string-color": rgb("--c-ok"),
  "--w-rjv-type-string-color": rgb("--c-ok"),
  "--w-rjv-type-int-color": rgb("--c-accent"),
  "--w-rjv-type-float-color": rgb("--c-accent"),
  "--w-rjv-type-bigint-color": rgb("--c-accent"),
  "--w-rjv-type-boolean-color": rgb("--c-warn"),
  "--w-rjv-type-date-color": rgb("--c-warn"),
  "--w-rjv-type-url-color": rgb("--c-accent"),
  "--w-rjv-type-null-color": rgb("--c-err"),
  "--w-rjv-type-nan-color": rgb("--c-err"),
  "--w-rjv-type-undefined-color": rgb("--c-err"),
  "--w-rjv-key-string": rgb("--c-accent"),
  "--w-rjv-key-number": rgb("--c-accent"),
} as React.CSSProperties;

export function JsonView({
  value,
  collapsed = 2,
  displayDataTypes = false,
}: {
  value: unknown;
  collapsed?: number | boolean;
  displayDataTypes?: boolean;
}) {
  return (
    <div className="text-[12px]">
      <JsonViewCore
        value={value as object}
        style={themeStyle}
        collapsed={collapsed}
        displayDataTypes={displayDataTypes}
        displayObjectSize={false}
        enableClipboard
        indentWidth={16}
      />
    </div>
  );
}
