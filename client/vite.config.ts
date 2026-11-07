import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

/**
 * Stamps the service worker (public/sw.js) with this build: a version, so
 * browsers see a changed worker on every deploy (which drives the "new
 * version" toast), and the list of JS and CSS files to save for offline use.
 * Fonts and images are saved as they're first used instead.
 */
function serviceWorkerBuild(): Plugin {
  let outDir = "dist"
  let files: string[] = []
  return {
    name: "vidura-service-worker",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    generateBundle(_, bundle) {
      files = Object.keys(bundle)
        .filter((name) => /^assets\/.*\.(js|css)$/.test(name))
        .sort()
        .map((name) => `/${name}`)
    },
    closeBundle() {
      const path = resolve(outDir, "sw.js")
      const build = createHash("sha256")
        .update(files.join("\n"))
        .digest("hex")
        .slice(0, 12)
      const source = readFileSync(path, "utf8")
        .replace("__VIDURA_BUILD__", build)
        .replace("/*__VIDURA_PRECACHE__*/ []", JSON.stringify(files))
      writeFileSync(path, source)
    },
  }
}

// The client portal has its own host (vidura.…) and calls the API on
// another (api-vidura.…). Set VITE_API_URL for development; production builds
// read the API address from a <meta> tag the server fills in.
export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss(), serviceWorkerBuild()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
})
