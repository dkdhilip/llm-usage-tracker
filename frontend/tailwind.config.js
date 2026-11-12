import defaultTheme from "tailwindcss/defaultTheme";

/** @type {import('tailwindcss').Config} */
const role = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Inter first (self-hosted, see main.tsx), then the system fonts if it has not loaded yet
      fontFamily: { sans: ["Inter Variable", ...defaultTheme.fontFamily.sans] },
      colors: {
        // semantic tokens — values come from CSS vars in index.css (light + dark)
        surface: role("surface"),
        "surface-2": role("surface-2"),
        "surface-raised": role("surface-raised"),
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
        // blue-violet, anchored on #5B5BD6 (600). 600 carries white text at 5.4:1; 700 is its hover.
        brand: {
          50: "#f5f5ff",
          100: "#e8e9ff",
          200: "#d3d5ff",
          300: "#b1b4fb",
          400: "#8f91f7",
          500: "#6e6fe0",
          600: "#5b5bd6",
          700: "#4c4cc4",
          800: "#3e3ea6",
          900: "#2a2b72",
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
