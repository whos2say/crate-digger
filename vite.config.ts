import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, /api and /s are proxied to `npm run dev:worker` (see scripts/dev-worker.mjs).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8788", "/s": "http://127.0.0.1:8788" },
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
});
