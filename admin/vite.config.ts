import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// The Go server serves this app under /admin/ and the API on the same
// origin. In development, Vite proxies API and auth calls to it, so cookies
// and Origin checks behave exactly as in production.
const backend = process.env.VIDURA_BACKEND ?? "http://localhost:8790"

export default defineConfig({
  base: "/admin/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/admin/api": { target: backend },
      "/api": { target: backend },
      "/auth": { target: backend },
    },
  },
})
