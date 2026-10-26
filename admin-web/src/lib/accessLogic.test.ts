import { describe, expect, it } from "vitest";
import { assertAdminAccess } from "./accessLogic";
import { AdminApiError } from "./errors";

describe("assertAdminAccess", () => {
  it("rejects an expired session distinctly from authorization", () => {
    expect(() => assertAdminAccess({ authenticated: false, isAdmin: false })).toThrow(
      expect.objectContaining<Partial<AdminApiError>>({ code: "UNAUTHENTICATED" }),
    );
  });

  it("rejects an authenticated non-admin", () => {
    expect(() => assertAdminAccess({ authenticated: true, isAdmin: false })).toThrow(
      expect.objectContaining<Partial<AdminApiError>>({ code: "FORBIDDEN" }),
    );
  });

  it("accepts an authenticated administrator", () => {
    expect(() => assertAdminAccess({ authenticated: true, isAdmin: true })).not.toThrow();
  });
});
