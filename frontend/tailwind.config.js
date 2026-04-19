/** @type {import('tailwindcss').Config} */
const c = (v) => `rgb(var(${v}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: c("--c-bg"),
        panel: c("--c-panel"),
        panel2: c("--c-panel2"),
        border: c("--c-border"),
        accent: c("--c-accent"),
        accent2: c("--c-accent2"),
        ok: c("--c-ok"),
        warn: c("--c-warn"),
        err: c("--c-err"),
        muted: c("--c-muted"),
        fg: c("--c-fg"),
      },
    },
  },
  plugins: [],
};
