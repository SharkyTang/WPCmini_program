import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { adminApi } from "../lib/api";
import type { AuthSession } from "../types";

interface AuthContextValue {
  session: AuthSession | null;
  loading: boolean;
  signIn: (account: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshSession = useCallback(async () => {
    setLoading(true);
    try {
      const next = await adminApi.getSession();
      if (next) await adminApi.checkAccess();
      setSession(next);
    } catch {
      setSession(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const signIn = useCallback(async (account: string, password: string) => {
    const next = await adminApi.signIn(account, password);
    setSession(next);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await adminApi.signOut();
    } finally {
      setSession(null);
    }
  }, []);

  const value = useMemo(
    () => ({ session, loading, signIn, signOut, refreshSession }),
    [session, loading, signIn, signOut, refreshSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
