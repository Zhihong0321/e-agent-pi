import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 47821,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:47831",
        timeout: 310000,
        proxyTimeout: 310000,
      },
    },
  },
  preview: {
    port: 47822,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:47831",
        timeout: 310000,
        proxyTimeout: 310000,
      },
    },
  },
});
