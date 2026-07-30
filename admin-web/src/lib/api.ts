import type { AdminApi } from "../types";
import { CloudbaseAdminApi } from "./cloudbaseAdapter";

const useMocks =
  import.meta.env.DEV && import.meta.env.VITE_USE_MOCKS === "true";

async function createAdminApi(): Promise<AdminApi> {
  if (useMocks) {
    const { MockAdminApi } = await import("./mockAdapter");
    return new MockAdminApi();
  }
  return new CloudbaseAdminApi();
}

export const adminApi: AdminApi = await createAdminApi();

export function isDemoMode(): boolean {
  return adminApi.mode === "mock";
}
