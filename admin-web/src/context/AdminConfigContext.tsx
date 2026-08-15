import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { DEFAULT_CONFIG } from "../constants";
import { adminApi } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import type { AdminConfig } from "../types";

interface AdminConfigValue {
  config: AdminConfig;
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
}

const AdminConfigContext = createContext<AdminConfigValue | null>(null);

export function AdminConfigProvider({ children }: PropsWithChildren) {
  const [config, setConfig] = useState({ ...DEFAULT_CONFIG, writeEnabled: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setConfig(await adminApi.getAdminConfig());
    } catch (reason) {
      setError(getErrorMessage(reason, "后台配置读取失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const value = useMemo(
    () => ({ config, loading, error, reload }),
    [config, loading, error, reload],
  );

  return <AdminConfigContext.Provider value={value}>{children}</AdminConfigContext.Provider>;
}

export function useAdminConfig(): AdminConfigValue {
  const context = useContext(AdminConfigContext);
  if (!context) throw new Error("useAdminConfig must be used inside AdminConfigProvider");
  return context;
}
