import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const modulePath = resolve(
  __dirname,
  "../miniprogram/cloudfunctions/notificationDispatcher/index.js"
);
const logic = require(resolve(
  __dirname,
  "../miniprogram/cloudfunctions/notificationDispatcher/notificationDispatcherLogic.js"
));

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function matches(record, condition = {}) {
  return Object.entries(condition).every(([key, expected]) => {
    if (expected && expected.operator === "in") {
      return expected.values.includes(record[key]);
    }
    if (expected && expected.operator === "lte") {
      return new Date(record[key]).getTime() <= new Date(expected.value).getTime();
    }
    return record[key] === expected;
  });
}

function loadDispatcher(options = {}) {
  const collections = clone(options.collections || {});
  const sends = [];
  const sendImpl = options.sendImpl || (async () => ({}));

  function createCollection(name) {
    const records = collections[name] || (collections[name] = []);
    const state = { condition: null, limit: Infinity };
    return {
      where(condition) {
        state.condition = condition;
        return this;
      },
      orderBy() {
        return this;
      },
      limit(value) {
        state.limit = value;
        return this;
      },
      async get() {
        const filtered = state.condition
          ? records.filter((record) => matches(record, state.condition))
          : records;
        return { data: clone(filtered.slice(0, state.limit)) };
      },
      doc(id) {
        return {
          async get() {
            const record = records.find((item) => item._id === id);
            if (!record) {
              const error = new Error("document not found");
              error.code = "DATABASE_DOCUMENT_NOT_EXIST";
              throw error;
            }
            return { data: clone(record) };
          },
          async set(payload) {
            const index = records.findIndex((item) => item._id === id);
            const next = { _id: id, ...clone(payload.data || {}) };
            if (index === -1) records.push(next);
            else records[index] = next;
            return {};
          },
          async update(payload) {
            const record = records.find((item) => item._id === id);
            if (!record) throw new Error("document not found");
            Object.assign(record, clone(payload.data || {}));
            return {};
          },
        };
      },
    };
  }

  const database = {
    command: {
      in(values) {
        return { operator: "in", values };
      },
      lte(value) {
        return { operator: "lte", value };
      },
    },
    serverDate() {
      return new Date();
    },
    collection: createCollection,
    async runTransaction(handler) {
      return handler({ collection: createCollection });
    },
  };
  const mockCloud = {
    DYNAMIC_CURRENT_ENV: "dynamic-env",
    init() {},
    database() {
      return database;
    },
    getWXContext() {
      return { OPENID: options.openid || "admin_openid" };
    },
    openapi: {
      subscribeMessage: {
        async send(payload) {
          sends.push(clone(payload));
          return sendImpl(payload);
        },
      },
    },
  };
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console,
    Date,
    process: {
      env: {
        ADMIN_OPENIDS: "admin_openid",
        VERSION_UPDATE_TEMPLATE_ID: "valid_template_id_1234567890",
        PRODUCT_NEW_TEMPLATE_ID: "valid_product_template_1234567890",
        SUBSCRIBE_MESSAGE_STATE: "developer",
      },
    },
    require(moduleName) {
      if (moduleName === "wx-server-sdk") return mockCloud;
      if (moduleName === "./notificationDispatcherLogic") return logic;
      throw new Error(`Unexpected require: ${moduleName}`);
    },
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(readFileSync(modulePath, "utf8"), sandbox, {
    filename: modulePath,
  });
  return {
    main: sandbox.module.exports.main,
    collections,
    sends,
  };
}

function buildCollections(overrides = {}) {
  const publishedAt = new Date(Date.now() - 1000);
  return {
    notification_push_jobs: [{
      _id: "job_1",
      announcementId: "notice_1",
      status: "pending",
      successCount: 2,
      failedCount: 1,
      skippedCount: 0,
      createdAt: new Date(Date.now() - 2000),
    }],
    app_notifications: [{
      _id: "notice_1",
      type: "version_update",
      title: "版本更新",
      content: "新版本已经上线",
      isVisible: true,
      publishStatus: "published",
      publishedAt,
    }],
    notification_subscriptions: [{
      _id: "subscription_1",
      openid: "customer_1",
      type: "version_update",
      templateId: "valid_template_id_1234567890",
      status: "granted",
      grantedAt: new Date(publishedAt.getTime() - 1000),
      updatedAt: new Date(publishedAt.getTime() - 1000),
    }],
    notification_delivery_logs: [],
    ...overrides,
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

await test("delivery ids are deterministic and do not expose raw OpenID", () => {
  const first = logic.buildDeliveryId("notice_1", "customer_openid");
  const second = logic.buildDeliveryId("notice_1", "customer_openid");
  assert.equal(first, second);
  assert.equal(first.length, 32);
  assert.equal(first.includes("customer_openid"), false);
  assert.notEqual(first, logic.buildDeliveryId("notice_2", "customer_openid"));
});

await test("only pending or expired processing jobs can be leased", () => {
  assert.equal(logic.isJobClaimable({ _id: "1", status: "pending" }, 100), true);
  assert.equal(logic.isJobClaimable({
    _id: "1",
    status: "processing",
    leaseUntil: new Date(101),
  }, 100), false);
  assert.equal(logic.isJobClaimable({
    _id: "1",
    status: "processing",
    leaseUntil: new Date(99),
  }, 100), true);
  assert.equal(logic.isJobClaimable({ _id: "1", status: "completed" }, 100), false);
});

await test("dispatcher sends once, consumes the grant, and merges latest counts", async () => {
  const { main, collections, sends } = loadDispatcher({
    collections: buildCollections(),
  });
  const result = await main({ action: "timer" });
  assert.equal(result.ok, true);
  assert.equal(result.status, "partial_failed");
  assert.equal(sends.length, 1);
  assert.equal(collections.notification_subscriptions[0].status, "consumed");
  assert.equal(collections.notification_delivery_logs.length, 1);
  assert.equal(collections.notification_delivery_logs[0].status, "success");
  assert.equal(collections.notification_push_jobs[0].successCount, 3);
  assert.equal(collections.notification_push_jobs[0].failedCount, 1);
  assert.equal(collections.notification_push_jobs[0].leaseOwner, "");
});

await test("an active lease prevents a concurrent invocation from sending twice", async () => {
  let releaseSend;
  const sendBlocked = new Promise((resolve) => {
    releaseSend = resolve;
  });
  const dispatcher = loadDispatcher({
    collections: buildCollections(),
    sendImpl: () => sendBlocked,
  });
  const firstRun = dispatcher.main({ action: "timer" });
  while (dispatcher.sends.length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const concurrent = await dispatcher.main({ action: "timer" });
  assert.equal(concurrent.ok, true);
  assert.equal(["idle", "busy"].includes(concurrent.status), true);
  assert.equal(dispatcher.sends.length, 1);
  releaseSend({});
  await firstRun;
  assert.equal(dispatcher.sends.length, 1);
});

await test("a deterministic delivery record makes a resumed job idempotent", async () => {
  const deliveryId = logic.buildDeliveryId("notice_1", "customer_1");
  const collections = buildCollections({
    notification_delivery_logs: [{
      _id: deliveryId,
      announcementId: "notice_1",
      openid: "customer_1",
      status: "success",
    }],
  });
  const dispatcher = loadDispatcher({ collections });
  const result = await dispatcher.main({ action: "timer" });
  assert.equal(result.ok, true);
  assert.equal(dispatcher.sends.length, 0);
  assert.equal(result.counts.success, 1);
  assert.equal(result.counts.skipped, 0);
  assert.equal(dispatcher.collections.notification_subscriptions[0].status, "consumed");
});
