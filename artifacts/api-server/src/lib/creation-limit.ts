/**
 * A fixed-window counter for sandbox creation per client address.  New
 * anonymous workspaces seed two lenders each, so their creation is bounded
 * separately from the general request limit.  In-memory, per process.
 */
export const WORKSPACE_CREATION_LIMIT = 20;
export const WORKSPACE_CREATION_WINDOW_MS = 60 * 60 * 1000;

export interface CreationLimiter {
  /** Returns true when a slot was taken; false when the key is over the limit for the current window. */
  take(key: string, nowMs: number): boolean;
  remaining(key: string, nowMs: number): number;
}

export function createCreationLimiter(limit = WORKSPACE_CREATION_LIMIT, windowMs = WORKSPACE_CREATION_WINDOW_MS): CreationLimiter {
  const windows = new Map<string, { count: number; reset: number }>();
  const current = (key: string, nowMs: number) => {
    const window = windows.get(key);
    if (!window || window.reset <= nowMs) {
      if (windows.size > 10_000) for (const [other, value] of windows) if (value.reset <= nowMs) windows.delete(other);
      const fresh = { count: 0, reset: nowMs + windowMs };
      windows.set(key, fresh);
      return fresh;
    }
    return window;
  };
  return {
    take(key, nowMs) {
      const window = current(key, nowMs);
      if (window.count >= limit) return false;
      window.count += 1;
      return true;
    },
    remaining(key, nowMs) { return Math.max(0, limit - current(key, nowMs).count); },
  };
}
