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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function matches(record, condition = {}) {
  return Object.keys(condition).every((key) => record[key] === condition[key]);
}

function loadNotificationAdmin(options = {}) {
  const collections = {
    app_notifications: clone(options.announcements || []),
    notification_push_jobs: clone(options.jobs || []),
  };
  const mockCloud = {
    DYNAMIC_CURRENT_ENV: "dynamic",
    init() {},
    getWXContext() {
      return { OPENID: options.openid || "admin_openid" };
    },
    database() {
      return {
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
  assert.equal(logic.sanitizeAnnouncement({ type: "unknown", title: "x", content: "x" }).code, "INVALID_TYPE");
  assert.equal(logic.sanitizeAnnouncement({ type: "version_update", title: "", content: "x" }).code, "INVALID_TITLE");
  assert.equal(logic.sanitizeAnnouncement({
    type: "product_new",
    title: "新品",
    content: "内容",
  }).code, "INVALID_CASE");
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

await test("product announcements are idempotent for the same case", async () => {
  const { main, collections } = loadNotificationAdmin({
    announcements: [{
      _id: "notice_existing",
      type: "product_new",
      caseDocId: "case_doc_1",
      title: "已有通知",
      content: "已有内容",
      publishStatus: "published",
    }],
  });
  const result = await main({
    action: "createAnnouncement",
    announcement: {
      type: "product_new",
      caseDocId: "case_doc_1",
      title: "重复通知",
      content: "重复内容",
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  assert.equal(result.id, "notice_existing");
  assert.equal(collections.app_notifications.length, 1);
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
