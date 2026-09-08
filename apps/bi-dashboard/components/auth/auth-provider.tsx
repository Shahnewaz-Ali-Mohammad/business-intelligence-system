'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export type AuthUser = { id: number; email: string; displayName: string | null };

type AuthContextValue = {
  user: AuthUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  refresh: async () => {},
  logout: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me');
      const body = (await res.json()) as { user: AuthUser | null };
      setUser(body.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/me')
      .then((res) => res.json())
      .then((body: { user: AuthUser | null }) => {
        if (!cancelled) setUser(body.user);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, refresh, logout }}>{children}</AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
