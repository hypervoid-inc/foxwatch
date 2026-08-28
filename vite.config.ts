import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { wgslVitePlugin } from "@vgpu/wgsl/loader-vite";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare(), wgslVitePlugin()],
  environments: {
    client: {
      build: {
        rollupOptions: {
          input: {
            main: resolve(root, "index.html"),
            globe: resolve(root, "apps/web/src/status-globe/main.ts"),
          },
          output: {
            entryFileNames: (chunk) => (chunk.name === "globe" ? "assets/globe.js" : "assets/[name]-[hash].js"),
            chunkFileNames: "assets/[name]-[hash].js",
            assetFileNames: "assets/[name]-[hash][extname]",
          },
        },
      },
    },
  },
});
