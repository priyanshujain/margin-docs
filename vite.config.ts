import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Ports are offset from margin's 1420/1421 and margin-calendar's 1430/1431, so all three apps can
// run side by side.
export default defineConfig({
  plugins: [react()],

  clearScreen: false,

  build: {
    // The app's CSP is font-src 'self', which refuses a data: URI, so a font small enough for Vite
    // to fold into the stylesheet is a font the browser then declines to load. KaTeX ships twenty
    // faces and exactly one of them, Size3, is under the 4kB default, which is the face display
    // math draws its large radicals and delimiters with. Fonts are always emitted as files.
    assetsInlineLimit: (file: string) => (/\.(woff2?|ttf|otf|eot)$/i.test(file) ? false : undefined),
  },

  server: {
    port: 1440,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1441,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
