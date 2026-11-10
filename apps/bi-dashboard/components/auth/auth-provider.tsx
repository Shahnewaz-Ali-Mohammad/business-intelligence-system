"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";

export type AuthUser = {
  id: number;
  email: string;
  displayName: string | null;
  roles?: string[];
  permissions?: string[];
  departments?: string[];
  mfaSetupRequired?: boolean;
  accessInstalled?: boolean;
};

/** True when the signed-in person's role allows this. The server checks again. */
export function can(user: AuthUser | null, permission: string) {
  return !!user?.permissions?.includes(permission);
}

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
  const pathname = usePathname();
  const router = useRouter();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me");
      const body = (await res.json()) as { user: AuthUser | null };
      setUser(body.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    // Clear protected content immediately; do not leave the old page visible
    // while the logout request is in flight.
    setUser(null);
    router.replace("/login");
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  }, [router]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me")
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

  // Admin and CEO accounts must set up two-step sign-in before anything else.
  useEffect(() => {
    if (
      user?.mfaSetupRequired &&
      !["/security", "/login", "/register"].includes(pathname)
    )
      router.replace("/security");
  }, [user, pathname, router]);

  useEffect(() => {
    if (!loading && !user && !["/login", "/register"].includes(pathname)) {
      router.replace("/login");
    }
  }, [loading, user, pathname, router]);

  const publicRoute = pathname === "/login" || pathname === "/register";

  return (
    <AuthContext.Provider value={{ user, loading, refresh, logout }}>
      {!loading && !user && !publicRoute ? (
        <main className="flex min-h-screen items-center justify-center bg-[#f5f6f8] text-sm text-zinc-500">
          Redirecting to sign in…
        </main>
      ) : (
        children
      )}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
