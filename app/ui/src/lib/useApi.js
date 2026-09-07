import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api.js';

/**
 * Fetch `path` whenever it changes, with in-flight cancellation and an
 * optional refresh interval. Returns { data, error, loading, reload }.
 */
export function useApi(path, { refreshMs = 0, enabled = true, onUnauthorized } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(Boolean(enabled));
  const abortRef = useRef(null);
  const unauthRef = useRef(onUnauthorized);
  unauthRef.current = onUnauthorized;

  const load = useCallback(
    async (quiet = false) => {
      if (!enabled || !path) return;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      if (!quiet) setLoading(true);
      try {
        const result = await api.get(path, { signal: ac.signal });
        if (!ac.signal.aborted) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (ac.signal.aborted || err?.name === 'AbortError') return;
        if (err instanceof ApiError && err.status === 401) unauthRef.current?.();
        setError(err);
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    },
    [path, enabled]
  );

  useEffect(() => {
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  useEffect(() => {
    if (!refreshMs || !enabled) return undefined;
    const t = setInterval(() => load(true), refreshMs);
    return () => clearInterval(t);
  }, [refreshMs, enabled, load]);

  return { data, error, loading, reload: () => load(true) };
}

/** Persist a small piece of UI state per browser. */
export function useLocalState(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : JSON.parse(raw);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode, quota, or blocked site data — the default still works */
    }
  }, [key, value]);
  return [value, setValue];
}
