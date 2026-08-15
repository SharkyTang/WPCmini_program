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
  sdkMock.app.callFunction.mockReset();
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

test("云函数网关请求显式解析对象返回值", async () => {
  sdkMock.app.callFunction.mockResolvedValueOnce({
    result: {
      ok: true,
      config: {
        writeEnabled: true,
      },
    },
  });
  const { CloudbaseAdminApi } = await import("./cloudbaseAdapter");
  const api = new CloudbaseAdminApi();

  await expect(api.getAdminConfig()).resolves.toMatchObject({
    writeEnabled: true,
  });
  expect(sdkMock.app.callFunction).toHaveBeenCalledWith({
    name: "caseAdmin",
    data: { action: "getAdminConfig" },
    parse: true,
  });
});

test("云函数网关顶层错误不会被吞成只读配置", async () => {
  sdkMock.app.callFunction.mockResolvedValueOnce({
    code: "DATABASE_COLLECTION_NOT_EXIST",
    message: "collection wine_packaging does not exist",
    requestId: "request-1",
  });
  const { CloudbaseAdminApi } = await import("./cloudbaseAdapter");
  const api = new CloudbaseAdminApi();

  await expect(api.getAdminConfig()).rejects.toMatchObject({
    code: "DATABASE_COLLECTION_NOT_EXIST",
    message: "collection wine_packaging does not exist",
  });
});

test("云函数 JSON 字符串返回值可被正确解析", async () => {
  sdkMock.app.callFunction.mockResolvedValueOnce({
    result: JSON.stringify({
      ok: true,
      config: {
        writeEnabled: true,
      },
    }),
  });
  const { CloudbaseAdminApi } = await import("./cloudbaseAdapter");
  const api = new CloudbaseAdminApi();

  await expect(api.getAdminConfig()).resolves.toMatchObject({
    writeEnabled: true,
  });
});
