import { defineConfig } from "electron-vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import packageJson from "./package.json" with { type: "json" }
import opencodePackageJson from "../cli/package.json" with { type: "json" }

const nodePtyPkg = `@lydell/node-pty-${process.platform}-${process.arch}`

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: "src/main/index.ts",
          imBridgeSidecar: "vendor/opencode-im-bridge/src/index.ts",
        },
      },
      externalizeDeps: {
        exclude: ["@opencode/client"],
        include: [nodePtyPkg],
      },
    },
    plugins: [
      {
        name: "custom-electron:node-pty-narrower",
        enforce: "pre",
        resolveId(source) {
          if (source === "@lydell/node-pty") return nodePtyPkg
        },
      },
    ],
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: "src/preload/index.ts",
        },
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    define: {
      __APP_VERSION__: JSON.stringify(packageJson.version),
      __OPENCODE_VERSION__: JSON.stringify(opencodePackageJson.version),
    },
    plugins: [react(), tailwindcss()],
    server: {
      port: 46237,
      strictPort: false,
    },
    build: {
      chunkSizeWarningLimit: 1500,
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
        },
        output: {
          manualChunks(id) {
            const module = id.replaceAll("\\", "/")
            if (!module.includes("/node_modules/")) return
            if (module.includes("/react/") || module.includes("/react-dom/") || module.includes("/scheduler/")) {
              return "vendor-react"
            }
            if (module.includes("/@codemirror/") || module.includes("/@lezer/")) return "vendor-editor"
            if (module.includes("/@xterm/")) return "vendor-terminal"
            if (module.includes("/i18next/") || module.includes("/react-i18next/")) return "vendor-i18n"
            if (module.includes("/lucide-react/")) return "vendor-icons"
            if (module.includes("/@opencode-ai/sdk/")) return "vendor-sdk"
          },
        },
      },
    },
  },
})
