// Local preview of the UI against prod data. Not part of the build.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
const target = "https://e-agent.up.railway.app";
const api = { target, changeOrigin: true, secure: true, cookieDomainRewrite: "localhost",
  configure: (proxy) => proxy.on("proxyReq", (req) => { req.setHeader("origin", target); req.removeHeader("referer"); }) };
export default defineConfig({
  root: "E:/000/UIv2",
  plugins: [react()],
  server: { host: "localhost", port: 47823, strictPort: true, proxy: { "/api": api, "/files": api, "/reports": api } },
});
