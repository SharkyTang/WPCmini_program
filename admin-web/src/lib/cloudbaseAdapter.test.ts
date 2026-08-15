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
  const listener = { close: vi.fn() };
  const query = {} as Record<string, ReturnType<typeof vi.fn>>;
  query.where = vi.fn(() => query);
  query.orderBy = vi.fn(() => query);
  query.limit = vi.fn(() => query);
  query.watch = vi.fn(() => listener);
  const database = {
    collection: vi.fn(() => query),
  };
  const app = {
    auth,
    callFunction: vi.fn(),
    storage: {
      from: vi.fn(),
    },
    database: vi.fn(() => database),
  };
  return {
    app,
    auth,
    database,
    listener,
    query,
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
  sdkMock.app.database.mockClear();
  sdkMock.database.collection.mockClear();
  sdkMock.query.where.mockClear();
  sdkMock.query.orderBy.mockClear();
  sdkMock.query.limit.mockClear();
  sdkMock.query.watch.mockClear();
  sdkMock.listener.close.mockClear();
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

test("上传同步动作只发送轻量任务元数据", async () => {
  sdkMock.app.callFunction.mockResolvedValue({ result: { ok: true } });
  const { CloudbaseAdminApi } = await import("./cloudbaseAdapter");
  const api = new CloudbaseAdminApi();

  await api.registerUploadItems([{
    mutationId: "mutation-1",
    uploadBatchId: "batch-1",
    title: "宴会案例",
    imageCount: 2,
    packageTypes: ["礼盒"],
    scenes: ["宴会"],
    status: "waiting",
  }]);
  await api.updateUploadItemStatus("mutation-1", {
    status: "processing",
    title: "宴会案例",
    scenes: ["宴会"],
  });

  expect(sdkMock.app.callFunction).toHaveBeenNthCalledWith(1, {
    name: "caseAdmin",
    data: {
      action: "registerUploadItems",
      items: [expect.objectContaining({
        mutationId: "mutation-1",
        imageCount: 2,
        scenes: ["宴会"],
      })],
    },
    parse: true,
  });
  expect(sdkMock.app.callFunction).toHaveBeenNthCalledWith(2, {
    name: "caseAdmin",
    data: expect.objectContaining({
      action: "updateUploadItemStatus",
      mutationId: "mutation-1",
      status: "processing",
    }),
    parse: true,
  });
});

test("管理员动态按当前 viewerUid 建立只读实时监听", async () => {
  const { CloudbaseAdminApi } = await import("./cloudbaseAdapter");
  const api = new CloudbaseAdminApi();
  const onChange = vi.fn();
  const onError = vi.fn();

  const subscription = api.subscribeAdminActivity("uid-1", onChange, onError);
  const watchOptions = sdkMock.query.watch.mock.calls[0][0];
  watchOptions.onChange({
    docs: [{
      eventId: "event-1",
      actor: { type: "cloudbase_uid", id: "uid-2" },
      actorDisplayName: "sharky",
      action: "case_moved_to_trash",
      title: "案例 A",
      createdAt: "2026-08-15T01:00:00.000Z",
    }],
  });

  expect(sdkMock.database.collection).toHaveBeenCalledWith("case_admin_activity_feed");
  expect(sdkMock.query.where).toHaveBeenCalledWith({ viewerUid: "uid-1" });
  expect(sdkMock.query.orderBy).toHaveBeenCalledWith("createdAt", "desc");
  expect(sdkMock.query.limit).toHaveBeenCalledWith(50);
  expect(onChange).toHaveBeenCalledWith([
    expect.objectContaining({
      id: "event-1",
      actorId: "uid-2",
      actorLabel: "sharky",
      action: "case_moved_to_trash",
    }),
  ]);

  subscription.close();
  expect(sdkMock.listener.close).toHaveBeenCalledOnce();
});

test("永久删除适配层保留清理作业统计", async () => {
  sdkMock.app.callFunction.mockResolvedValueOnce({
    result: {
      ok: true,
      deleted: 2,
      cleanupJobId: "purge-1",
      deletedFileCount: 7,
      retainedReferencedCount: 1,
      pendingFileCount: 2,
    },
  });
  const { CloudbaseAdminApi } = await import("./cloudbaseAdapter");
  const api = new CloudbaseAdminApi();

  await expect(api.permanentlyDeleteCases(
    ["case-1", "case-2"],
    { "case-1": 2, "case-2": 4 },
    "mutation-purge-1",
  )).resolves.toEqual({
    deleted: 2,
    cleanupJobId: "purge-1",
    deletedFileCount: 7,
    retainedReferencedCount: 1,
    pendingFileCount: 2,
  });
});

test("待清理作业只保留安全统计并过滤已完成项", async () => {
  sdkMock.app.callFunction.mockResolvedValueOnce({
    result: {
      ok: true,
      items: [
        {
          deleted: 1,
          cleanupJobId: "purge-pending-1",
          clientMutationId: "mutation-purge-pending-1",
          deletedFileCount: 4,
          retainedReferencedCount: 1,
          pendingFileCount: 2,
          status: "cleanup_release_pending",
          createdAt: "2026-08-15T01:00:00.000Z",
          updatedAt: { $date: 1786759200000 },
          pendingFileIDs: ["cloud://must-not-reach-browser/private.jpg"],
        },
        {
          deleted: 1,
          cleanupJobId: "purge-complete-1",
          clientMutationId: "mutation-purge-complete-1",
          deletedFileCount: 3,
          retainedReferencedCount: 0,
          pendingFileCount: 0,
          status: "completed",
        },
        {
          pendingFileCount: 3,
          status: "cleanup_pending",
        },
      ],
    },
  });
  const { CloudbaseAdminApi } = await import("./cloudbaseAdapter");
  const api = new CloudbaseAdminApi();

  const jobs = await api.listPendingPurgeJobs({
    clientMutationId: "mutation-purge-pending-1",
  });

  expect(jobs).toEqual([
    {
      deleted: 1,
      cleanupJobId: "purge-pending-1",
      clientMutationId: "mutation-purge-pending-1",
      deletedFileCount: 4,
      retainedReferencedCount: 1,
      pendingFileCount: 2,
      status: "cleanup_release_pending",
      createdAt: "2026-08-15T01:00:00.000Z",
      updatedAt: "2026-08-15T02:00:00.000Z",
    },
  ]);
  expect(jobs[0]).not.toHaveProperty("pendingFileIDs");
  expect(sdkMock.app.callFunction).toHaveBeenCalledWith({
    name: "caseAdmin",
    data: {
      action: "listPendingPurgeJobs",
      clientMutationId: "mutation-purge-pending-1",
    },
    parse: true,
  });
});
