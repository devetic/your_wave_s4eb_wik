import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/scan": "http://localhost:3000",
      "/stream": "http://localhost:3000",
      "/bridge": "http://localhost:3000",
      "/playlists": "http://localhost:3000",
      "/download": "http://localhost:3000",
      "/offline": "http://localhost:3000",
    },
  },
  build: {
    outDir: "web-dist",
  },
});
