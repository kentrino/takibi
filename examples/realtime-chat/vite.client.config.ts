import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [tailwindcss()],
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "hono/jsx/dom",
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(import.meta.dirname, "src/client/main.tsx"),
      output: {
        entryFileNames: "main.js",
        assetFileNames: "main[extname]",
      },
    },
  },
});
