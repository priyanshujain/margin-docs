// The fixture behind the app, reachable from a test.
//
// Two specs need it now, so it lives here rather than in one of them: tests/external-changes.spec.ts
// drives the watcher over this wire, and tests/bytes.spec.ts reads what the autosave actually put on
// disk. Both of them are claims about the file, and a claim about the file needs the file.
//
// This is a shim, not a mock of the app: what is behind it is src/dev/mockIpc.ts, the same fixture
// `pnpm dev` runs against, so a test here exercises every branch the packaged binary takes.

import { type Page } from "@playwright/test";

declare global {
  interface Window {
    __disk: {
      /**
       * Changes the folder from outside the app and puts the resulting `watch-event`s on the bus.
       * Returns, per event, how many listeners actually received it, so a test can tell a working
       * subscription apart from a payload that fell on the floor.
       */
      change(name: string, args: unknown[]): Promise<number[]>;
      /** Asks the fixture something. Changes nothing and emits nothing. */
      ask(name: string, args: unknown[]): Promise<unknown>;
    };
  }
}

/**
 * Enough of Tauri's JavaScript side for the real `@tauri-apps/api` to run against: an `invoke` that
 * answers commands, the synchronous callback registry `transformCallback` needs, and the event
 * plugin's listen and unlisten. Deliberately not `@tauri-apps/api/mocks`, which cannot be reached
 * from an init script, and deliberately hand-rolled to the same contract rather than to a
 * convenient one.
 *
 * Runs at document start on every navigation, before any module of the app is evaluated, which is
 * what matters: `isTauri` in src/ipc.ts is computed once at import time.
 */
export function installTauriShim(): void {
  interface Backend {
    mockCall(command: string, args?: Record<string, unknown>): Promise<unknown>;
    external: Record<string, (...args: unknown[]) => unknown>;
  }

  const listeners = new Map<string, Set<number>>();
  const callbacks = new Map<number, (data: unknown) => void>();
  let nextId = 1;

  const registerCallback = (fn?: (data: unknown) => void, once = false): number => {
    const id = nextId;
    nextId += 1;
    callbacks.set(id, (data) => {
      if (once) callbacks.delete(id);
      fn?.(data);
    });
    return id;
  };

  const unregisterCallback = (id: number): void => {
    callbacks.delete(id);
  };

  const forget = (event: string, id: number): void => {
    listeners.get(event)?.delete(id);
    unregisterCallback(id);
  };

  const emit = (event: string, payload: unknown): number => {
    let delivered = 0;
    for (const id of [...(listeners.get(event) ?? [])]) {
      const fn = callbacks.get(id);
      if (!fn) continue;
      fn({ event, id, payload });
      delivered += 1;
    }
    return delivered;
  };

  // A variable specifier so this stays a runtime import of a Vite-served source file rather than
  // something the test's own compiler tries to resolve.
  const specifier = "/src/dev/mockIpc.ts";
  let loading: Promise<Backend> | null = null;
  const backend = (): Promise<Backend> => (loading ??= import(specifier) as Promise<Backend>);

  const invoke = async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    const a = (args ?? {}) as Record<string, unknown>;
    if (command === "plugin:event|listen") {
      const event = a.event as string;
      const handler = a.handler as number;
      const set = listeners.get(event) ?? new Set<number>();
      set.add(handler);
      listeners.set(event, set);
      return handler;
    }
    if (command === "plugin:event|unlisten") {
      forget(a.event as string, a.eventId as number);
      return null;
    }
    // The window, dialog and opener commands have nothing to act on in a browser tab, and nothing
    // in this suite emits from the frontend. Answering rather than throwing keeps the app's own
    // startup (the close-requested handler, chiefly) from filling the console with rejections.
    if (command.startsWith("plugin:") || command.startsWith("core:")) return null;
    return (await backend()).mockCall(command, args);
  };

  const internals = {
    invoke,
    transformCallback: registerCallback,
    unregisterCallback,
    runCallback: (id: number, data: unknown) => callbacks.get(id)?.(data),
    callbacks,
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    },
    convertFileSrc: (path: string) => path,
    plugins: {},
  };

  const global = window as unknown as Record<string, unknown>;
  global.__TAURI_INTERNALS__ = internals;
  global.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: forget };

  window.__disk = {
    async change(name, args) {
      const events = (await backend()).external[name](...args) as unknown[];
      // The literal, not the constant: this is one of the two ends being tied together.
      return events.map((event) => emit("watch-event", event));
    },
    async ask(name, args) {
      const answer = (await backend()).external[name](...args);
      return answer === undefined ? null : answer;
    },
  };
}

export function change(page: Page, name: string, ...args: unknown[]): Promise<number[]> {
  return page.evaluate((call) => window.__disk.change(call.name, call.args), { name, args });
}

export function ask<T>(page: Page, name: string, ...args: unknown[]): Promise<T> {
  return page.evaluate((call) => window.__disk.ask(call.name, call.args), {
    name,
    args,
  }) as Promise<T>;
}
