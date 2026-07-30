import { afterEach, beforeEach, expect, test, vi } from "vitest";

const sdkMock = vi.hoisted(() => {
  const auth = Object.assign(vi.fn(() => {
    throw new TypeError("CloudBase v3 auth should be used as an initialized property");
  }), {
    getSession: vi.fn(async () => ({
      data: { session: null },
      error: null,
    })),
    signInWithPassword: vi.fn(),
    signOut: vi.fn(),
  });
  const app = {
    auth,
    callFunction: vi.fn(),
    storage: {
      from: vi.fn(),
    },
  };
  return {
    app,
    auth,
    init: vi.fn(() => app),
  };
});

vi.mock("@cloudbase/js-sdk", () => ({
  default: {
    init: sdkMock.init,
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VITE_CLOUDBASE_ENV_ID", "test-env");
  vi.stubEnv("VITE_CLOUDBASE_PUBLISHABLE_KEY", "test-publishable-key");
  sdkMock.auth.getSession.mockClear();
  sdkMock.init.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

test("CloudBase v3 auth 作为已初始化属性使用，不把它当函数再次调用", async () => {
  const { CloudbaseAdminApi } = await import("./cloudbaseAdapter");
  const api = new CloudbaseAdminApi();

  await expect(api.getSession()).resolves.toBeNull();
  expect(sdkMock.init).toHaveBeenCalledOnce();
  expect(sdkMock.auth).not.toHaveBeenCalled();
  expect(sdkMock.auth.getSession).toHaveBeenCalledOnce();
});
