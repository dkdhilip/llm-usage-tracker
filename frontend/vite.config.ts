/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173 },
  preview: { host: true, port: 5173 },
  test: {
    environment: "jsdom",
    testTimeout: 15000, // the Workspace page is large; a jsdom interaction test can take a few seconds
    globals: true,
    setupFiles: "./src/test/setup.ts",
  },
});
