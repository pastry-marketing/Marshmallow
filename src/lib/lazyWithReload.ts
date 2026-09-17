import { lazy, type ComponentType } from "react";

// After a deploy, Vite gives every code-split chunk a new hashed filename. A tab
// still running the previous index.html then tries to lazy-load a chunk that no
// longer exists on the server ("Failed to fetch dynamically imported module"),
// which is a stale-cache blip, not a real error. Reloading once pulls the fresh
// index.html with the correct filenames and everything works — so we do that
// automatically instead of dropping the user on an error screen.

const RELOAD_GUARD_KEY = "chunkReloadAt";
// Never reload more than once within this window, so a genuinely-broken build
// (or an offline user) can't get stuck in a reload loop — the error boundary
// takes over instead.
const RELOAD_GUARD_MS = 10_000;

function isStaleChunkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return (
    /dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg) ||
    /Failed to fetch/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg) ||
    /'text\/html'/i.test(msg) // server returned index.html for a missing .js
  );
}

/** Reload once for a stale chunk. Returns true if a reload was triggered. */
function reloadOnceForStaleChunk(): boolean {
  const now = Date.now();
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) || "0");
  } catch {
    // sessionStorage can throw in private mode — fall through and reload anyway.
  }
  if (now - last < RELOAD_GUARD_MS) return false;
  try {
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(now));
  } catch {
    // ignore
  }
  window.location.reload();
  return true;
}

/**
 * Drop-in replacement for React.lazy that recovers from post-deploy stale-chunk
 * failures by reloading the page once. Any other error is rethrown so the error
 * boundary still handles real bugs.
 */
export function lazyWithReload<T extends ComponentType<unknown>>(
  factory: () => Promise<{ default: T }>,
) {
  return lazy(async () => {
    try {
      return await factory();
    } catch (err) {
      if (isStaleChunkError(err) && reloadOnceForStaleChunk()) {
        // Block until the reload takes over so React never surfaces the error.
        await new Promise<never>(() => {});
      }
      throw err;
    }
  });
}

/**
 * Also catch Vite's module-preload failures (the <link rel="modulepreload">
 * error that fires before a lazy import even runs) and reload once.
 */
export function installStaleChunkReloadHandler() {
  window.addEventListener("vite:preloadError", (event) => {
    event.preventDefault();
    reloadOnceForStaleChunk();
  });
}
