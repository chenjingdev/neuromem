import { useCallback, useEffect, useState } from "react";

export interface RemoteState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  retry: () => void;
  setData: React.Dispatch<React.SetStateAction<T | null>>;
}

export function useRemote<T>(load: () => Promise<T>, dependencies: unknown[] = []): RemoteState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);

  const retry = useCallback(() => setRevision(value => value + 1), []);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    load().then(value => {
      if (!current) return;
      setData(value);
      setLoading(false);
    }).catch(reason => {
      if (!current) return;
      setError(reason);
      setLoading(false);
    });
    return () => { current = false; };
    // The caller owns the dependency list. `revision` powers an explicit retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependencies, revision]);

  return { data, error, loading, retry, setData };
}
