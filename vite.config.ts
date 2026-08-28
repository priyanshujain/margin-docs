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

    // The markdown suites are thousands of generated documents pushed through the writer inside one
    // synchronous loop, and the worst of them holds a worker's event loop for the better part of
    // half a minute even on a fast machine. Everything below exists because of that.
    //
    // A worker tells the main process about each test it starts, over an RPC call it then waits on,
    // and that call is given sixty seconds before it gives up with `Timeout calling "onTaskUpdate"`.
    // A test that blocks the loop cannot take delivery of the answer while it is running, so what
    // the sixty seconds really bounds is the length of the slowest single test, not the round trip.
    // Vitest does not expose that timeout, so the only lever left is keeping the tests from getting
    // slower, and what makes them slower is contention. The default is one worker per core bar one,
    // which on a two or three core hosted runner has the heaviest suites fighting each other and the
    // main process for the same cores. Half the cores gives each worker a core to itself and still
    // leaves one for the main process to answer on. This is a percentage rather than a number
    // behind a CI check because it lands on the right answer for a two core runner, a three core
    // one and a developer's laptop without anyone having to know which one the job got, and it
    // costs nothing locally: the run is bounded by its slowest single file either way.
    maxWorkers: "50%",

    // Five seconds is the default and nothing in the markdown suites honours it. The slow tests
    // pass their own timeout to `it` as a third argument. The merely slow-ish ones do not, and they
    // are the ones that go red on a loaded runner having done nothing wrong. Thirty seconds is what
    // most of the annotated tests already ask for, and it stays under the sixty the RPC allows, so
    // this cannot itself cause the failure described above.
    testTimeout: 30_000,
    hookTimeout: 30_000,

    // How long a worker is given to shut down before it is killed. Ten seconds is plenty when the
    // machine is idle and is not when several forks are all winding up at once.
    teardownTimeout: 30_000,
  },
});
