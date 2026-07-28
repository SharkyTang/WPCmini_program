import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const functionPath = resolve(
  __dirname,
  "../miniprogram/cloudfunctions/notificationAdmin/index.js"
);
const logic = require(resolve(
  __dirname,
  "../miniprogram/cloudfunctions/notificationAdmin/notificationAdminLogic.js"
));
const adminPagePath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/notification-admin/index.js"
);
const adminWxmlPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/notification-admin/index.wxml"
);
const adminWxssPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/notification-admin/index.wxss"
);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function matches(record, condition = {}) {
  return Object.keys(condition).every((key) => {
    const expected = condition[key];
    if (expected && expected.__op === "in") {
      return expected.values.includes(record[key]);
    }
    return record[key] === expected;
  });
}

function loadNotificationAdmin(options = {}) {
  const collections = {
    app_notifications: clone(options.announcements || []),
    notification_push_jobs: clone(options.jobs || []),
    notification_delivery_logs: clone(options.deliveryLogs || []),
    wine_packaging: clone(options.cases || []),
  };
  const mockCloud = {
    DYNAMIC_CURRENT_ENV: "dynamic",
    init() {},
    getWXContext() {
      return { OPENID: options.openid || "admin_openid" };
    },
    database() {
      return {
        command: {
          in(values) {
            return { __op: "in", values };
          },
        },
        serverDate() {
          return "server-date";
        },
        collection(name) {
          const records = collections[name] || [];
          collections[name] = records;
          let condition = {};
          let skipValue = 0;
          let limitValue = Infinity;
          const query = {
            where(value) {
              condition = value;
              return this;
            },
            orderBy() {
              return this;
            },
            skip(value) {
              skipValue = value;
              return this;
            },
            limit(value) {
              limitValue = value;
              return this;
            },
            async get() {
              return {
                data: clone(records.filter((item) => matches(item, condition)).slice(skipValue, skipValue + limitValue)),
              };
            },
            async add(payload) {
              const id = `${name}_${records.length + 1}`;
              records.push({ _id: id, ...clone(payload.data || {}) });
              return { _id: id };
            },
            async remove() {
              const matchedIds = new Set(
                records.filter((item) => matches(item, condition)).map((item) => item._id)
              );
              for (let index = records.length - 1; index >= 0; index -= 1) {
                if (matchedIds.has(records[index]._id)) records.splice(index, 1);
              }
              return { stats: { removed: matchedIds.size } };
            },
            doc(id) {
              return {
                async get() {
                  const item = records.find((record) => record._id === id);
                  if (!item) throw new Error("not found");
                  return { data: clone(item) };
                },
                async update(payload) {
                  const item = records.find((record) => record._id === id);
                  if (!item) throw new Error("not found");
                  Object.assign(item, clone(payload.data || {}));
                  return {};
                },
                async remove() {
                  const index = records.findIndex((record) => record._id === id);
                  if (index < 0) throw new Error("not found");
                  records.splice(index, 1);
                  return { stats: { removed: 1 } };
                },
              };
            },
          };
          return query;
        },
      };
    },
  };
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console,
    process: {
      env: {
        ADMIN_OPENIDS: options.adminOpenids || "admin_openid",
      },
    },
    require(moduleName) {
      if (moduleName === "wx-server-sdk") return mockCloud;
      if (moduleName === "./notificationAdminLogic") return logic;
      throw new Error(`Unexpected require: ${moduleName}`);
    },
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(readFileSync(functionPath, "utf8"), sandbox, {
    filename: functionPath,
  });
  return {
    main: sandbox.module.exports.main,
    collections,
  };
}

function loadNotificationAdminPage() {
  let page;
  const calls = {
    deletes: [],
    listLoads: 0,
    toasts: [],
  };
  const sandbox = {
    Page(config) {
      page = config;
    },
    require(moduleName) {
      if (moduleName === "../../utils/notificationAdminService") {
        return {
          DEFAULT_PAGE_SIZE: 20,
          checkNotificationAdminAccess: async () => true,
          deleteAnnouncement: async (id) => {
            calls.deletes.push(id);
          },
          fetchAnnouncementList: async () => {
            calls.listLoads += 1;
            return {
              items: [],
              page: 1,
              hasMore: false,
            };
          },
          fetchDeliverySummary: async () => ({}),
          publishAnnouncement: async () => ({}),
          setAnnouncementVisibility: async () => ({}),
        };
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    console,
    wx: {
      showToast(request) {
        calls.toasts.push(request);
      },
      showModal() {},
      navigateTo() {},
      stopPullDownRefresh() {},
    },
  };
  vm.runInNewContext(readFileSync(adminPagePath, "utf8"), sandbox, {
    filename: adminPagePath,
  });
  page.setData = function setData(nextData) {
    Object.entries(nextData).forEach(([key, value]) => {
      if (key === "confirmDialog.show") {
        this.data.confirmDialog = {
          ...this.data.confirmDialog,
          show: value,
        };
        return;
      }
      this.data[key] = value;
    });
  };
  page.setData({ isAdmin: true });
  return { page, calls };
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

await test("notification admin validates public announcement fields", () => {
  assert.equal(logic.VALID_NOTIFICATION_ADMIN_ACTIONS.includes("publishAnnouncement"), true);
  assert.equal(logic.VALID_NOTIFICATION_ADMIN_ACTIONS.includes("getAnnouncement"), true);
  assert.equal(logic.VALID_NOTIFICATION_ADMIN_ACTIONS.includes("deleteAnnouncement"), true);
  assert.equal(logic.VALID_NOTIFICATION_ADMIN_ACTIONS.includes("getPublishedLinkedCases"), true);
  assert.equal(logic.sanitizeAnnouncement({ type: "unknown", title: "x", content: "x" }).code, "INVALID_TYPE");
  assert.equal(logic.sanitizeAnnouncement({ type: "version_update", title: "", content: "x" }).code, "INVALID_TITLE");
  assert.equal(logic.sanitizeAnnouncement({
    type: "product_new",
    title: "新品",
    content: "内容",
  }).code, "INVALID_CASE");
  assert.deepEqual(
    clone(logic.normalizeCaseDocIds("case_1，case_2; case_1 case_3")),
    ["case_1", "case_2", "case_3"]
  );
  assert.equal(logic.sanitizeAnnouncement({
    type: "product_new",
    title: "新品",
    content: "内容",
    caseDocIds: Array.from({ length: 21 }, (_, index) => `case_${index}`),
  }).code, "TOO_MANY_CASES");
});

await test("non admins cannot create announcements", async () => {
  const { main, collections } = loadNotificationAdmin({
    openid: "customer_openid",
  });
  const result = await main({
    action: "createAnnouncement",
    announcement: {
      type: "version_update",
      title: "新版本",
      content: "更新内容",
    },
  });
  assert.equal(result.code, "FORBIDDEN");
  assert.equal(collections.app_notifications.length, 0);
});

await test("creating a notification stores a hidden draft", async () => {
  const { main, collections } = loadNotificationAdmin();
  const result = await main({
    action: "createAnnouncement",
    announcement: {
      type: "version_update",
      title: "新版本",
      content: "更新内容",
      version: "1.1.0",
    },
  });
  assert.equal(result.ok, true);
  assert.equal(collections.app_notifications[0].publishStatus, "draft");
  assert.equal(collections.app_notifications[0].isVisible, false);
});

await test("publishing makes a draft public and creates one push job", async () => {
  const { main, collections } = loadNotificationAdmin({
    announcements: [{
      _id: "notice_1",
      type: "version_update",
      title: "新版本",
      content: "更新内容",
      publishStatus: "draft",
      isVisible: false,
    }],
  });
  const result = await main({
    action: "publishAnnouncement",
    id: "notice_1",
    sendSubscription: true,
  });
  assert.equal(result.ok, true);
  assert.equal(collections.app_notifications[0].isVisible, true);
  assert.equal(collections.app_notifications[0].publishStatus, "published");
  assert.equal(collections.notification_push_jobs.length, 1);
});

await test("published announcements can update content but cannot change type", async () => {
  const source = {
    _id: "notice_1",
    type: "version_update",
    title: "旧标题",
    content: "旧内容",
    version: "1.0.0",
    publishStatus: "published",
    isVisible: true,
  };
  const { main, collections } = loadNotificationAdmin({
    announcements: [source],
  });
  const updateResult = await main({
    action: "updateAnnouncement",
    id: "notice_1",
    announcement: {
      type: "version_update",
      title: "新标题",
      content: "新内容",
      version: "1.0.1",
    },
  });
  const typeResult = await main({
    action: "updateAnnouncement",
    id: "notice_1",
    announcement: {
      type: "product_new",
      title: "错误类型",
      content: "内容",
      caseDocId: "case_doc_1",
    },
  });

  assert.equal(updateResult.ok, true);
  assert.equal(collections.app_notifications[0].title, "新标题");
  assert.equal(collections.app_notifications[0].publishStatus, "published");
  assert.equal(collections.app_notifications[0].isVisible, true);
  assert.equal(typeResult.code, "TYPE_LOCKED");
});

await test("deleting an announcement removes its completed jobs and delivery logs", async () => {
  const { main, collections } = loadNotificationAdmin({
    announcements: [{
      _id: "notice_1",
      type: "version_update",
      publishStatus: "published",
    }],
    jobs: [{
      _id: "job_1",
      announcementId: "notice_1",
      status: "completed",
    }],
    deliveryLogs: [{
      _id: "log_1",
      announcementId: "notice_1",
      openid: "customer_1",
    }],
  });
  const result = await main({
    action: "deleteAnnouncement",
    id: "notice_1",
  });

  assert.equal(result.ok, true);
  assert.equal(collections.app_notifications.length, 0);
  assert.equal(collections.notification_push_jobs.length, 0);
  assert.equal(collections.notification_delivery_logs.length, 0);
});

await test("deleting is rejected while a push job is pending", async () => {
  const { main, collections } = loadNotificationAdmin({
    announcements: [{
      _id: "notice_1",
      type: "version_update",
      publishStatus: "published",
    }],
    jobs: [{
      _id: "job_1",
      announcementId: "notice_1",
      status: "pending",
    }],
  });
  const result = await main({
    action: "deleteAnnouncement",
    id: "notice_1",
  });

  assert.equal(result.code, "PUSH_IN_PROGRESS");
  assert.equal(collections.app_notifications.length, 1);
  assert.equal(collections.notification_push_jobs.length, 1);
});

await test("non admins cannot delete announcements", async () => {
  const { main, collections } = loadNotificationAdmin({
    openid: "customer_openid",
    announcements: [{
      _id: "notice_1",
      type: "version_update",
    }],
  });
  const result = await main({
    action: "deleteAnnouncement",
    id: "notice_1",
  });

  assert.equal(result.code, "FORBIDDEN");
  assert.equal(collections.app_notifications.length, 1);
});

await test("notification admin actions use two columns and expose edit and delete", () => {
  const wxml = readFileSync(adminWxmlPath, "utf8");
  const wxss = readFileSync(adminWxssPath, "utf8");
  assert.equal(wxml.includes("editAnnouncement"), true);
  assert.equal(wxml.includes("requestDelete"), true);
  assert.equal(wxml.includes("推送统计"), true);
  assert.equal(wxss.includes("grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)"), true);
});

await test("delete confirmation cancels cleanly and only deletes after confirmation", async () => {
  const { page, calls } = loadNotificationAdminPage();
  page.requestDelete({
    currentTarget: { dataset: { id: "notice_1" } },
  });
  await page.handleConfirmDialogTap({ detail: { index: 0 } });
  assert.equal(calls.deletes.length, 0);

  page.requestDelete({
    currentTarget: { dataset: { id: "notice_1" } },
  });
  await page.handleConfirmDialogTap({ detail: { index: 1 } });
  assert.deepEqual(calls.deletes, ["notice_1"]);
  assert.equal(calls.listLoads, 1);
  assert.equal(calls.toasts.at(-1).title, "已删除");
});

await test("product announcements support multiple ordered cases without reusing old notices", async () => {
  const { main, collections } = loadNotificationAdmin({
    cases: [
      { _id: "case_doc_1", title: "案例一", isVisible: true },
      { _id: "case_doc_2", title: "案例二", isVisible: true },
    ],
    announcements: [{
      _id: "notice_existing",
      type: "product_new",
      caseDocId: "case_doc_1",
      caseDocIds: ["case_doc_1"],
      title: "已有通知",
      content: "已有内容",
      publishStatus: "published",
    }],
  });
  const result = await main({
    action: "createAnnouncement",
    announcement: {
      type: "product_new",
      caseDocIds: ["case_doc_2", "case_doc_1"],
      title: "重复通知",
      content: "重复内容",
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.reused, false);
  assert.equal(collections.app_notifications.length, 2);
  assert.deepEqual(
    clone(collections.app_notifications[1].caseDocIds),
    ["case_doc_2", "case_doc_1"]
  );
  assert.equal(
    collections.app_notifications[1].targetPage,
    `/pages/notification-cases/index?announcementId=${result.id}`
  );
});

await test("published linked cases are public, ordered, and omit hidden cases", async () => {
  const { main } = loadNotificationAdmin({
    openid: "customer_openid",
    cases: [
      { _id: "case_doc_1", title: "案例一", isVisible: true },
      { _id: "case_doc_2", title: "隐藏案例", isVisible: false },
      { _id: "case_doc_3", title: "案例三", isVisible: true },
    ],
    announcements: [{
      _id: "notice_product",
      type: "product_new",
      caseDocIds: ["case_doc_3", "case_doc_2", "case_doc_1"],
      caseDocId: "case_doc_3",
      title: "本周上新",
      publishStatus: "published",
      isVisible: true,
    }],
  });
  const result = await main({
    action: "getPublishedLinkedCases",
    announcementId: "notice_product",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(clone(result.items.map((item) => item._id)), ["case_doc_3", "case_doc_1"]);
  assert.equal(result.unavailableCount, 1);
});

await test("dispatcher source batches, deduplicates, and consumes one-time grants", () => {
  const source = readFileSync(
    resolve(__dirname, "../miniprogram/cloudfunctions/notificationDispatcher/index.js"),
    "utf8"
  );
  assert.equal(source.includes("const BATCH_SIZE = 20"), true);
  assert.equal(source.includes('{ title: "thing4", content: "thing5", time: "time7" }'), true);
  assert.equal(source.includes('{ title: "thing1", time: "date2", content: "thing3" }'), true);
  assert.equal(source.includes('keyword.startsWith("date")'), true);
  assert.equal(source.includes("findDelivery(announcement._id, subscription.openid)"), true);
  assert.equal(source.includes('status: "consumed"'), true);
  assert.equal(source.includes("cloud.openapi.subscribeMessage.send"), true);
});
