/**
 * Async state with loading, error and retry.
 *
 * Every async surface in the UI needs the same three states, so they are
 * modelled once here rather than hand-rolled per screen.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ immediate?: boolean, deps?: unknown[] }} [options]
 */
export function useAsync(fn, options = {}) {
  const { immediate = true, deps = [] } = options;

  const [data, setData] = useState(/** @type {T | null} */ (null));
  const [error, setError] = useState(/** @type {Error | null} */ (null));
  const [loading, setLoading] = useState(immediate);

  const mounted = useRef(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fnRef.current();
      // Guard against setting state after unmount, which is a real risk when a
      // slow first request races the user navigating away.
      if (mounted.current) setData(result);
      return result;
    } catch (err) {
      if (mounted.current) setError(err);
      return null;
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (immediate) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, run, setData };
}
