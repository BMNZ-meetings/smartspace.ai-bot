import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    css: false,
    environmentMatchGlobs: [
      ["src/**/__tests__/**", "happy-dom"],
      ["src/serverless-tests/**", "node"],
    ],
    setupFiles: ["./test/setup.js"],
  },
});
