/** @type {import('tailwindcss').Config} */
const role = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // semantic tokens — values come from CSS vars in index.css (light + dark)
        surface: role("surface"),
        "surface-2": role("surface-2"),
        fill: role("fill"),
        fg: role("fg"),
        "fg-muted": role("fg-muted"),
        "fg-subtle": role("fg-subtle"),
        line: role("line"), // decorative borders
        control: role("control"), // the boundary of an input, select or button
        "brand-text": role("brand-text"),
        "brand-soft": role("brand-soft"),
        "brand-soft-2": role("brand-soft-2"),
        // status roles: `-fg` text on `-soft` fill, `-line` for borders and bars
        success: { fg: role("success-fg"), soft: role("success-soft"), line: role("success-line") },
        warning: { fg: role("warning-fg"), soft: role("warning-soft"), line: role("warning-line") },
        danger: { fg: role("danger-fg"), soft: role("danger-soft"), line: role("danger-line") },
        info: { fg: role("info-fg"), soft: role("info-soft"), line: role("info-line") },
        brand: {
          50: "#eef2ff",
          100: "#e0e7ff",
          200: "#c7d2fe",
          300: "#a5b4fc",
          400: "#818cf8",
          500: "#6366f1",
          600: "#4f46e5",
          700: "#4338ca",
          800: "#3730a3",
          900: "#312e81",
        },
      },
      // type scale. 11px (`meta`) is for uppercase labels and IDs only, always at AA contrast.
      fontSize: {
        meta: ["11px", "16px"],
        ui: ["13px", "18px"],
        title: ["20px", "28px"],
        page: ["28px", "36px"],
        kpi: ["28px", "36px"],
        "kpi-lg": ["36px", "44px"],
      },
    },
  },
  plugins: [],
};
