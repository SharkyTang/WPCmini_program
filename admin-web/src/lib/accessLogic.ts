import { AdminApiError } from "./errors";

export interface AccessResult {
  authenticated?: boolean;
  isAdmin?: boolean;
}

export function assertAdminAccess(result: AccessResult): void {
  if (result.authenticated === false) {
    throw new AdminApiError("UNAUTHENTICATED", "登录已过期，请重新登录");
  }
  if (result.isAdmin !== true) {
    throw new AdminApiError("FORBIDDEN", "当前账号没有案例管理权限");
  }
}
