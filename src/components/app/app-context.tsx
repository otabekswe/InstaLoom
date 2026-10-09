"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { PublicInstagramAccount } from "@/types";
import { api, errorMessage, isAbortError } from "@/lib/client";

export type PublicAccount = PublicInstagramAccount;
type SessionUser = { id: string; name: string | null };
type AppState = {
  accounts: PublicAccount[];
  user: SessionUser | null;
  loading: boolean;
  error: string | null;
  refreshAccounts: () => Promise<void>;
  retry: () => void;
};
const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [accounts, setAccounts] = useState<PublicAccount[]>([]);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      api<{ accounts: PublicAccount[] }>("/api/accounts", { signal: controller.signal }),
      api<{ user: SessionUser }>("/api/auth/session", { signal: controller.signal }),
    ]).then(([accountData, session]) => {
      if (controller.signal.aborted) return;
      setAccounts(accountData.accounts);
      setUser(session.user);
      setError(null);
      setLoading(false);
    }).catch((cause) => {
      if (!isAbortError(cause)) { setError(errorMessage(cause)); setLoading(false); }
    });
    return () => controller.abort();
  }, [attempt]);
  const refreshAccounts = useCallback(async () => {
    const data = await api<{ accounts: PublicAccount[] }>("/api/accounts");
    setAccounts(data.accounts);
  }, []);
  const retry = useCallback(() => { setLoading(true); setAttempt((value) => value + 1); }, []);
  return <AppContext.Provider value={{ accounts, user, loading, error, refreshAccounts, retry }}>{children}</AppContext.Provider>;
}

export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside AppProvider");
  return value;
}
