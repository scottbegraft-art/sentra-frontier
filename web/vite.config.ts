import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Phase 1D: proxy to 127.0.0.1 explicitly, matching the API's default
  // loopback bind (localhost could resolve to ::1, which the API does
  // not listen on by default).
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:4000" } },
});
