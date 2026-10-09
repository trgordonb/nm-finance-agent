import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies /api to the Express backend (src/index.ts, port 3001).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
