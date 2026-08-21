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
  "../miniprogram/cloudfunctions/userData/index.js"
);
const logic = require(resolve(
  __dirname,
  "../miniprogram/cloudfunctions/userData/userDataLogic.js"
));

function createQuery(collectionName, calls, records = []) {
  const state = {
    condition: null,
    orders: [],
    limit: Infinity,
  };
  const comparable = (value, field) => {
    if (field === "createdAt" || field === "updatedAt" || value instanceof Date) {
      return new Date(value).getTime();
    }
    return value;
  };
  const matches = (item) => {
    if (!state.condition) return true;
    return Object.entries(state.condition).every(([key, expected]) => {
      if (expected && typeof expected === "object" && "$lt" in expected) {
        return comparable(item[key], key) < comparable(expected.$lt, key);
      }
      if (expected && typeof expected === "object" && "$gt" in expected) {
        return comparable(item[key], key) > comparable(expected.$gt, key);
      }
      if (expected && typeof expected === "object" && "$gte" in expected) {
        return comparable(item[key], key) >= comparable(expected.$gte, key);
      }
      if (key === "createdAt" || key === "updatedAt") {
        return comparable(item[key], key) === comparable(expected, key);
      }
      return item[key] === expected;
    });
  };
  const select = () => {
    const selected = records.filter(matches);
    if (state.orders.length) {
      selected.sort((left, right) => {
        for (const { field, direction } of state.orders) {
          const leftValue = comparable(left[field], field);
          const rightValue = comparable(right[field], field);
          if (leftValue === rightValue) continue;
          const result = leftValue < rightValue ? -1 : 1;
          return direction === "desc" ? -result : result;
        }
        return 0;
      });
    }
    return selected.slice(0, state.limit);
  };
  return {
    where(condition) {
      calls.push({ collectionName, type: "where", condition });
      state.condition = condition;
      return this;
    },
    orderBy(field, direction) {
      calls.push({ collectionName, type: "orderBy", field, direction });
      state.orders.push({ field, direction });
      return this;
    },
    limit(value) {
      calls.push({ collectionName, type: "limit", value });
      state.limit = value;
      return this;
    },
    field() {
      return this;
    },
    async get() {
      return { data: select() };
    },
    async count() {
      return { total: records.filter(matches).length };
    },
    async update(payload) {
      for (const record of records.filter(matches)) Object.assign(record, payload.data || {});
      return { stats: { updated: records.filter(matches).length } };
    },
  };
}

function loadUserDataFunction(options = {}) {
  const calls = [];
  const added = [];
  const recordsByCollection = {
    ...(options.recordsByCollection || {}),
  };
  if (options.records) {
    recordsByCollection.user_profiles = options.records;
  }
  const mockCloud = {
    DYNAMIC_CURRENT_ENV: "dynamic-env",
    init() {},
    getWXContext() {
      return {
        OPENID: options.openid || "openid_1",
        APPID: options.appid || "wx351f937287eb5886",
      };
    },
    async getTempFileURL({ fileList }) {
      return {
        fileList: fileList.map((fileID) => ({
          fileID,
          tempFileURL: `https://temp/${encodeURIComponent(fileID)}`,
        })),
      };
    },
    async callFunction(payload) {
      calls.push({ type: "callFunction", payload });
      if (options.callFunctionError) throw options.callFunctionError;
      if (options.callFunctionImpl) return options.callFunctionImpl(payload);
      return options.callFunctionResponse || { result: { ok: true, status: "sent" } };
    },
    openapi: {
      subscribeMessage: {
        async getTemplateList() {
          if (options.templateListError) throw options.templateListError;
          return {
            data: options.templateList || [],
          };
        },
      },
    },
    database() {
      const database = {
        command: {
          lt(value) {
            return { $lt: value };
          },
          gt(value) {
            return { $gt: value };
          },
          gte(value) {
            return { $gte: value };
          },
        },
        serverDate() {
          return "server-date";
        },
        collection(collectionName) {
          const records = recordsByCollection[collectionName] || [];
          recordsByCollection[collectionName] = records;
          return {
            ...createQuery(collectionName, calls, records),
            async add(payload) {
              added.push({ collectionName, payload });
              records.push({
                _id: `${collectionName}_new`,
                ...(payload.data || {}),
              });
              return { _id: `${collectionName}_new` };
            },
            doc(id) {
              return {
                async get() {
                  const record = records.find((item) => item._id === id);
                  if (!record) throw new Error("document not found");
                  return { data: record };
                },
                async update(payload) {
                  calls.push({ collectionName, type: "update", id, payload });
                  const record = records.find((item) => item._id === id);
                  if (record) Object.assign(record, payload.data || {});
                  return {};
                },
                async set(payload) {
                  calls.push({ collectionName, type: "set", id, payload });
                  const index = records.findIndex((item) => item._id === id);
                  const record = { _id: id, ...(payload.data || {}) };
                  if (index >= 0) records[index] = record;
                  else records.push(record);
                  return {};
                },
              };
            },
          };
        },
      };
      database.runTransaction = async (handler) => handler(database);
      return database;
    },
  };
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console,
    setTimeout,
    clearTimeout,
    process: {
      env: {
        VERSION_UPDATE_TEMPLATE_ID: "version_template_id_1234567890",
        PRODUCT_NEW_TEMPLATE_ID: "product_template_id_1234567890",
        ...(options.env || {}),
      },
    },
    require(moduleName) {
      if (moduleName === "wx-server-sdk") return mockCloud;
      if (moduleName === "./userDataLogic") return logic;
      throw new Error(`Unexpected require: ${moduleName}`);
    },
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(readFileSync(modulePath, "utf8"), sandbox, {
    filename: modulePath,
  });
  return {
    main: sandbox.module.exports.main,
    calls,
    added,
    recordsByCollection,
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

await test("fetchSubscriptionStatus uses server openid and returns configured templates", async () => {
  const { main, calls } = loadUserDataFunction({
    openid: "server_openid",
    recordsByCollection: {
      notification_subscriptions: [{
        _id: "subscription_1",
        openid: "server_openid",
        type: "product_new",
        templateId: "product_template_id_1234567890",
        status: "granted",
      }],
    },
  });

  const result = await main({
    action: "fetchSubscriptionStatus",
    openid: "spoofed",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), {
    collectionName: "notification_subscriptions",
    type: "where",
    condition: {
      openid: "server_openid",
    },
  });
  assert.equal(result.subscriptions.product_new.status, "granted");
  assert.equal(result.templateIds.version_update, "version_template_id_1234567890");
  assert.equal(result.templateConfigs.version_update.valid, true);
});

await test("invalid template numbers are diagnosed and stale grants are ignored", async () => {
  const { main } = loadUserDataFunction({
    env: {
      VERSION_UPDATE_TEMPLATE_ID: "10103",
      PRODUCT_NEW_TEMPLATE_ID: "product_template_id_new_1234567890",
    },
    recordsByCollection: {
      notification_subscriptions: [{
        _id: "subscription_old",
        openid: "openid_1",
        type: "product_new",
        templateId: "product_template_id_old_1234567890",
        status: "granted",
      }],
    },
  });
  const result = await main({ action: "fetchSubscriptionStatus" });
  assert.equal(result.templateConfigs.version_update.valid, false);
  assert.equal(result.templateConfigs.version_update.envKey, "VERSION_UPDATE_TEMPLATE_ID");
  assert.equal(result.subscriptions.product_new.status, "idle");
  assert.equal(
    result.subscriptions.product_new.templateId,
    "product_template_id_new_1234567890"
  );
});

await test("verifySubscriptionTemplates checks the running AppID template list", async () => {
  const { main } = loadUserDataFunction({
    appid: "wx351f937287eb5886",
    templateList: [{
      priTmplId: "version_template_id_1234567890",
      title: "升级成功通知",
      type: 2,
    }],
  });

  const result = await main({ action: "verifySubscriptionTemplates" });

  assert.equal(result.ok, true);
  assert.equal(result.appid, "wx351f937287eb5886");
  assert.equal(result.verificationAvailable, true);
  assert.equal(result.templates.version_update.existsInCurrentApp, true);
  assert.equal(result.templates.version_update.title, "升级成功通知");
  assert.equal(result.templates.product_new.existsInCurrentApp, false);
  assert.equal(
    result.templates.product_new.code,
    "TEMPLATE_NOT_IN_CURRENT_APP"
  );
});

await test("verifySubscriptionTemplates validates inquiry reply ID and every configured field", async () => {
  const replyTemplateId = "reply_template_id_123456789012345";
  const { main } = loadUserDataFunction({
    env: {
      INQUIRY_REPLY_TEMPLATE_ID: replyTemplateId,
      INQUIRY_REPLY_TEMPLATE_FIELDS: JSON.stringify({
        title: "thing1",
        time: "time2",
        content: "thing3",
      }),
    },
    templateList: [{
      priTmplId: replyTemplateId,
      title: "咨询回复通知",
      type: 2,
      content: "处理事项{{thing1.DATA}}\n回复时间{{time2.DATA}}",
      fieldList: [{ code: "thing3", label: "回复状态" }],
      example: "这里是模板示例，不应出现在诊断响应中",
    }],
  });

  const result = await main({ action: "verifySubscriptionTemplates" });
  const diagnostic = result.templates.inquiry_reply;

  assert.equal(result.templates.version_update.valid, true);
  assert.equal(result.templates.product_new.valid, true);
  assert.equal(diagnostic.valid, true);
  assert.equal(diagnostic.existsInCurrentApp, true);
  assert.equal(diagnostic.fieldsMatch, true);
  assert.equal(diagnostic.usable, true);
  assert.equal(diagnostic.configuredFieldCount, 3);
  assert.equal(diagnostic.matchedFieldCount, 3);
  assert.equal(diagnostic.missingFieldCount, 0);
  assert.equal(diagnostic.title, "咨询回复通知");
  assert.equal(JSON.stringify(result).includes("这里是模板示例"), false);
  assert.equal(JSON.stringify(result).includes("{{thing1.DATA}}"), false);
});

await test("verifySubscriptionTemplates accepts the compact inquiry reply field mapping", async () => {
  const replyTemplateId = "reply_template_id_123456789012345";
  const { main } = loadUserDataFunction({
    env: {
      INQUIRY_REPLY_TEMPLATE_ID: replyTemplateId,
      INQUIRY_REPLY_TEMPLATE_FIELDS: "title=thing1,time=time2,content=thing3",
    },
    templateList: [{
      priTmplId: replyTemplateId,
      title: "咨询回复通知",
      content: "处理事项{{thing1.DATA}}\n回复时间{{time2.DATA}}\n回复状态{{thing3.DATA}}",
    }],
  });

  const result = await main({ action: "verifySubscriptionTemplates" });
  const diagnostic = result.templates.inquiry_reply;
  assert.equal(diagnostic.valid, true);
  assert.equal(diagnostic.configuredFieldCount, 3);
  assert.equal(diagnostic.fieldsMatch, true);
  assert.equal(diagnostic.usable, true);
});

await test("inquiry reply field mapping rejects unsafe compact and JSON forms", async () => {
  const replyTemplateId = "reply_template_id_123456789012345";
  const invalidMappings = [
    "title=thing1,,content=thing3",
    "title=thing1,",
    "title=thing1,title=thing2",
    "title=thing1,content=thing1",
    "title=thing-1",
    "title=thing1,\ncontent=thing3",
    "\ntitle=thing1,content=thing3",
    "unknown=thing1",
    "title=thing1=content",
    '{"title":"thing1","title":"thing2"}',
    '{"title":"thing1","content":"thing1"}',
  ];

  for (const mapping of invalidMappings) {
    const { main } = loadUserDataFunction({
      env: {
        INQUIRY_REPLY_TEMPLATE_ID: replyTemplateId,
        INQUIRY_REPLY_TEMPLATE_FIELDS: mapping,
      },
      templateList: [{
        priTmplId: replyTemplateId,
        title: "咨询回复通知",
        content: "处理事项{{thing1.DATA}}\n回复状态{{thing3.DATA}}",
      }],
    });
    const result = await main({ action: "verifySubscriptionTemplates" });
    assert.equal(result.templates.inquiry_reply.valid, false, mapping);
    assert.equal(result.templates.inquiry_reply.usable, false, mapping);
  }
});

await test("verifySubscriptionTemplates safely reports inquiry reply field mismatch", async () => {
  const replyTemplateId = "reply_template_id_123456789012345";
  const { main } = loadUserDataFunction({
    env: {
      INQUIRY_REPLY_TEMPLATE_ID: replyTemplateId,
      INQUIRY_REPLY_TEMPLATE_FIELDS: JSON.stringify({
        title: "thing1",
        time: "time2",
        content: "thing9",
      }),
    },
    templateList: [{
      priTmplId: replyTemplateId,
      title: "咨询回复通知",
      content: "处理事项{{thing1.DATA}}\n回复时间{{time2.DATA}}\n回复状态{{thing3.DATA}}",
    }],
  });

  const result = await main({ action: "verifySubscriptionTemplates" });
  const diagnostic = result.templates.inquiry_reply;
  assert.equal(diagnostic.existsInCurrentApp, true);
  assert.equal(diagnostic.fieldsMatch, false);
  assert.equal(diagnostic.usable, false);
  assert.equal(diagnostic.matchedFieldCount, 2);
  assert.equal(diagnostic.missingFieldCount, 1);
  assert.equal(diagnostic.code, "TEMPLATE_FIELDS_MISMATCH");
});

await test("template verification errors return only normalized diagnostics", async () => {
  const { main } = loadUserDataFunction({
    templateListError: Object.assign(
      new Error("private upstream response must stay hidden"),
      { code: "ETIMEDOUT:private" }
    ),
  });
  const result = await main({ action: "verifySubscriptionTemplates" });
  assert.equal(result.ok, true);
  assert.equal(result.verificationAvailable, false);
  assert.equal(result.verificationCode, "ETIMEDOUT_PRIVATE");
  assert.equal(
    JSON.stringify(result).includes("private upstream response must stay hidden"),
    false
  );
});

await test("saveSubscriptionGrant stores server openid and normalized status", async () => {
  const { main, added } = loadUserDataFunction({
    openid: "server_openid",
  });

  const result = await main({
    action: "saveSubscriptionGrant",
    type: "product_new",
    templateId: "product_template_id_1234567890",
    status: "accept",
    openid: "spoofed",
  });

  assert.equal(result.ok, true);
  assert.equal(added[0].collectionName, "notification_subscriptions");
  assert.equal(added[0].payload.data.openid, "server_openid");
  assert.equal(added[0].payload.data.status, "granted");
});

await test("submitInquiry stores server openid and sanitized fields", async () => {
  const { main, added } = loadUserDataFunction({
    openid: "server_openid",
  });

  const result = await main({
    action: "submitInquiry",
    inquiry: {
      packageTypes: ["礼盒"],
      content: "想做一套礼盒包装",
      contact: "wx-test",
      contactType: "wechat",
      openid: "spoofed",
      adminNote: "bad",
    },
    systemInfo: {
      brand: "Apple",
      model: "iPhone",
      platform: "ios",
      system: "iOS 19",
      version: "8.0.60",
      SDKVersion: "3.10.0",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(added[0].collectionName, "inquiries");
  assert.equal(added[0].payload.data.openid, "server_openid");
  assert.equal(added[0].payload.data.status, "new");
  assert.equal(added[0].payload.data.contactType, "wechat");
  assert.deepEqual(JSON.parse(JSON.stringify(added[0].payload.data.systemInfo)), {
    platform: "ios",
    system: "iOS 19",
    version: "8.0.60",
    SDKVersion: "3.10.0",
  });
  assert.equal(Object.prototype.hasOwnProperty.call(added[0].payload.data, "adminNote"), false);
});

await test("schema v2 requires contact type while legacy submissions stay compatible", async () => {
  const { main, added } = loadUserDataFunction({ openid: "server_openid" });
  const invalid = await main({
    action: "submitInquiry",
    inquiry: {
      inquirySchemaVersion: 2,
      packageTypes: ["礼盒"],
      content: "想做一套礼盒包装",
      contact: "wx-test",
    },
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, "INVALID_INQUIRY");

  const legacy = await main({
    action: "submitInquiry",
    inquiry: {
      packageTypes: ["礼盒"],
      content: "旧版客户提交的礼盒需求",
      contact: "wx-legacy",
    },
  });
  assert.equal(legacy.ok, true);
  assert.equal(added[0].payload.data.inquirySchemaVersion, 1);
  assert.equal(added[0].payload.data.contactType, "");
  assert.equal(added[0].payload.data.contactTypeSource, "legacy_missing");
});

await test("email notification failures never roll back a saved inquiry", async () => {
  const { main, added } = loadUserDataFunction({
    openid: "server_openid",
    env: {
      INQUIRY_FOLLOWUP_ENABLED: "true",
      INQUIRY_EMAIL_ALERTS_ENABLED: "true",
      INQUIRY_NOTIFIER_INTERNAL_TOKEN: "test-internal-token",
    },
    callFunctionError: Object.assign(new Error("smtp unavailable"), { code: "ETIMEOUT" }),
  });
  const result = await main({
    action: "submitInquiry",
    inquiry: {
      inquirySchemaVersion: 2,
      packageTypes: ["礼盒"],
      content: "希望做企业纪念礼盒",
      contact: "wx-test",
      contactType: "wechat",
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.alertStatus, "deferred");
  assert.equal(added.some((item) => item.collectionName === "inquiries"), true);
});

await test("notifier calls require the internal token while inquiry persistence stays available", async () => {
  const { main, added, calls } = loadUserDataFunction({
    openid: "server_openid",
    env: {
      INQUIRY_FOLLOWUP_ENABLED: "true",
      INQUIRY_EMAIL_ALERTS_ENABLED: "true",
    },
  });
  const result = await main({
    action: "submitInquiry",
    inquiry: {
      inquirySchemaVersion: 2,
      packageTypes: ["礼盒"],
      content: "希望做企业纪念礼盒",
      contact: "wx-test",
      contactType: "wechat",
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.alertStatus, "unavailable");
  assert.equal(added.some((item) => item.collectionName === "inquiries"), true);
  assert.equal(calls.some((item) => item.type === "callFunction"), false);
});

await test("notifier calls carry the internal token only in the server invocation", async () => {
  const { main, calls } = loadUserDataFunction({
    openid: "server_openid",
    env: {
      INQUIRY_FOLLOWUP_ENABLED: "true",
      INQUIRY_EMAIL_ALERTS_ENABLED: "true",
      INQUIRY_NOTIFIER_INTERNAL_TOKEN: "test-internal-token",
    },
  });
  const result = await main({
    action: "submitInquiry",
    inquiry: {
      inquirySchemaVersion: 2,
      packageTypes: ["礼盒"],
      content: "希望做企业纪念礼盒",
      contact: "wx-test",
      contactType: "wechat",
    },
  });
  const invocation = calls.find((item) => item.type === "callFunction");
  assert.equal(result.ok, true);
  assert.equal(result.alertStatus, "sent");
  assert.equal(invocation.payload.name, "inquiryNotifier");
  assert.equal(invocation.payload.data.action, "kick");
  assert.equal(invocation.payload.data.internalToken, "test-internal-token");
  assert.equal(Object.prototype.hasOwnProperty.call(result, "internalToken"), false);
});

await test("high-frequency submissions are saved but suppress additional email chains", async () => {
  const now = Date.now();
  const recent = Array.from({ length: 3 }, (_, index) => ({
    _id: `recent_${index}`,
    openid: "server_openid",
    createdAt: new Date(now - (index + 1) * 60 * 1000),
    status: "new",
    replyCount: 0,
  }));
  const { main, added, calls } = loadUserDataFunction({
    openid: "server_openid",
    env: {
      INQUIRY_FOLLOWUP_ENABLED: "true",
      INQUIRY_EMAIL_ALERTS_ENABLED: "true",
      INQUIRY_NOTIFIER_INTERNAL_TOKEN: "test-internal-token",
    },
    recordsByCollection: {
      inquiries: recent.concat([
        {
          _id: "stale_same_user",
          openid: "server_openid",
          createdAt: new Date(now - 11 * 60 * 1000),
        },
        {
          _id: "recent_other_user",
          openid: "other_openid",
          createdAt: new Date(now - 60 * 1000),
        },
      ]),
    },
  });
  const result = await main({
    action: "submitInquiry",
    inquiry: {
      inquirySchemaVersion: 2,
      packageTypes: ["礼盒"],
      content: "第四条需求仍然需要完整保存",
      contact: "wx-test",
      contactType: "wechat",
    },
  });
  const stored = added.find((item) => item.collectionName === "inquiries");
  assert.equal(result.ok, true);
  assert.equal(result.alertStatus, "suppressed");
  assert.equal(stored.payload.data.status, "new");
  assert.equal(stored.payload.data.replyCount, 0);
  assert.equal(stored.payload.data.alertTaskStatus, "suppressed");
  assert.equal(
    stored.payload.data.alertTaskStopReason,
    "submission_rate_limited"
  );
  assert.equal(calls.some((item) => item.type === "callFunction"), false);
});

await test("customer inquiry queries use server openid and hide internal fields", async () => {
  const { main } = loadUserDataFunction({
    openid: "customer_a",
    recordsByCollection: {
      inquiries: [
        {
          _id: "inquiry_a",
          openid: "customer_a",
          status: "contacted",
          content: "我的需求",
          contact: "wx-a",
          adminNote: "内部备注",
          updatedByOpenid: "admin_openid",
          customerUnreadCount: 1,
          createdAt: "2026-08-21T01:00:00.000Z",
        },
        {
          _id: "inquiry_b",
          openid: "customer_b",
          content: "别人的需求",
          createdAt: "2026-08-21T02:00:00.000Z",
        },
      ],
      inquiry_messages: [
        {
          _id: "message_a",
          inquiryId: "inquiry_a",
          content: "已经添加您的微信好友",
          createdByOpenid: "admin_openid",
          customerVisible: true,
          direction: "admin_to_customer",
          createdAt: "2026-08-21T03:00:00.000Z",
        },
      ],
    },
  });

  const list = await main({ action: "listMyInquiries", openid: "spoofed" });
  assert.equal(list.ok, true);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].id, "inquiry_a");
  assert.equal("adminNote" in list.items[0], false);
  assert.equal("updatedByOpenid" in list.items[0], false);

  const detail = await main({ action: "getMyInquiryDetail", id: "inquiry_a" });
  assert.equal(detail.ok, true);
  assert.equal(detail.messages.length, 1);
  assert.equal("createdByOpenid" in detail.messages[0], false);
  const forbidden = await main({ action: "getMyInquiryDetail", id: "inquiry_b" });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.code, "INQUIRY_NOT_FOUND");
});

await test("customer inquiry paging keeps every record that shares a createdAt millisecond", async () => {
  const sharedCreatedAt = "2026-08-21T04:00:00.123Z";
  const { main } = loadUserDataFunction({
    openid: "customer_a",
    recordsByCollection: {
      inquiries: [
        { _id: "inquiry_a", openid: "customer_a", createdAt: sharedCreatedAt },
        { _id: "inquiry_c", openid: "customer_a", createdAt: sharedCreatedAt },
        { _id: "inquiry_b", openid: "customer_a", createdAt: sharedCreatedAt },
        { _id: "inquiry_old", openid: "customer_a", createdAt: "2026-08-20T04:00:00.000Z" },
      ],
    },
  });

  const first = await main({ action: "listMyInquiries", pageSize: 2 });
  assert.deepEqual(
    JSON.parse(JSON.stringify(first.items.map((item) => item.id))),
    ["inquiry_c", "inquiry_b"]
  );
  assert.equal(first.hasMore, true);
  assert.equal(JSON.parse(first.nextCursor).id, "inquiry_b");

  const second = await main({
    action: "listMyInquiries",
    pageSize: 2,
    cursor: first.nextCursor,
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(second.items.map((item) => item.id))),
    ["inquiry_a", "inquiry_old"]
  );
  assert.equal(second.hasMore, false);
  assert.equal(new Set(first.items.concat(second.items).map((item) => item.id)).size, 4);
});

await test("customer detail pages every exact visible admin reply and read token preserves a concurrent reply", async () => {
  const inquiry = {
    _id: "inquiry_many",
    openid: "customer_a",
    replyCount: 105,
    customerLastReadReplyCount: 104,
    customerUnreadCount: 1,
    createdAt: "2026-08-21T01:00:00.000Z",
  };
  const visibleMessages = Array.from({ length: 105 }, (_, index) => ({
    _id: `message_${String(index).padStart(3, "0")}`,
    inquiryId: "inquiry_many",
    content: `reply ${index}`,
    customerVisible: true,
    direction: "admin_to_customer",
    createdAt: "2026-08-21T05:00:00.456Z",
  }));
  const { main } = loadUserDataFunction({
    openid: "customer_a",
    recordsByCollection: {
      inquiries: [inquiry],
      inquiry_messages: visibleMessages.concat([
        {
          _id: "message_missing_direction",
          inquiryId: "inquiry_many",
          content: "legacy ambiguous",
          customerVisible: true,
          createdAt: "2026-08-21T00:00:00.000Z",
        },
        {
          _id: "message_internal",
          inquiryId: "inquiry_many",
          content: "internal",
          customerVisible: false,
          direction: "admin_to_customer",
          createdAt: "2026-08-21T00:00:00.000Z",
        },
        {
          _id: "message_customer_direction",
          inquiryId: "inquiry_many",
          content: "wrong direction",
          customerVisible: true,
          direction: "customer_to_admin",
          createdAt: "2026-08-21T00:00:00.000Z",
        },
      ]),
    },
  });

  const collected = [];
  let cursor = "";
  let seenThroughToken = "";
  for (let page = 0; page < 3; page += 1) {
    const result = await main({
      action: "getMyInquiryDetail",
      id: "inquiry_many",
      messagePageSize: 50,
      messageCursor: cursor,
    });
    assert.equal(result.ok, true);
    collected.push(...result.messages);
    if (page < 2) {
      assert.equal(result.hasMoreMessages, true);
      assert.equal(result.seenThroughToken, "");
      cursor = result.nextMessageCursor;
    } else {
      assert.equal(result.hasMoreMessages, false);
      seenThroughToken = result.seenThroughToken;
      assert.equal(result.seenThroughReplyCount, 105);
    }
  }
  assert.equal(collected.length, 105);
  assert.equal(new Set(collected.map((message) => message.id)).size, 105);
  assert.equal(collected.some((message) => message.id === "message_missing_direction"), false);

  inquiry.replyCount = 106;
  inquiry.customerUnreadCount = 2;
  const receipt = await main({
    action: "markInquiryMessagesRead",
    id: "inquiry_many",
    seenThroughToken,
  });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.seenThroughReplyCount, 105);
  assert.equal(receipt.unreadCount, 1);
  assert.equal(inquiry.customerLastReadReplyCount, 105);
  assert.equal(inquiry.customerUnreadCount, 1);
});

await test("customer inquiry summaries include unread replies beyond the first 100 records", async () => {
  const inquiries = Array.from({ length: 150 }, (_, index) => ({
    _id: `inquiry_${String(index).padStart(3, "0")}`,
    openid: "customer_a",
    customerUnreadCount: 1,
    createdAt: "2026-08-21T01:00:00.000Z",
  }));
  const { main } = loadUserDataFunction({
    openid: "customer_a",
    recordsByCollection: { inquiries },
  });
  const summary = await main({ action: "getMyInquirySummary" });
  const badge = await main({ action: "getInquiryBadgeSummary" });
  assert.equal(summary.inquiryCount, 150);
  assert.equal(summary.unreadCount, 150);
  assert.equal(badge.myUnreadCount, 150);
});

await test("admin badge counts active inquiries awaiting their first visible reply", async () => {
  const { main } = loadUserDataFunction({
    openid: "admin_openid",
    env: { INQUIRY_ADMIN_OPENIDS: "admin_openid" },
    recordsByCollection: {
      inquiries: [
        { _id: "new_legacy", status: "new" },
        { _id: "claimed", status: "contacted", replyCount: 0 },
        { _id: "processing", status: "processing", replyCount: "0" },
        { _id: "legacy_status", replyCount: 0 },
        { _id: "done", status: "done", replyCount: 0 },
        { _id: "invalid", status: "invalid" },
        { _id: "already_replied", status: "new", replyCount: 1 },
      ],
    },
  });
  const badge = await main({ action: "getInquiryBadgeSummary" });
  assert.equal(badge.ok, true);
  assert.equal(badge.adminNewCount, 4);
  assert.equal(badge.adminPendingReplyCount, 4);
});

await test("slow notifier invocation is left running but submit returns deferred within its budget", async () => {
  let invocationStarted = false;
  const { main, added } = loadUserDataFunction({
    openid: "customer_a",
    env: {
      INQUIRY_FOLLOWUP_ENABLED: "true",
      INQUIRY_EMAIL_ALERTS_ENABLED: "true",
      INQUIRY_NOTIFIER_INTERNAL_TOKEN: "test-internal-token",
      INQUIRY_NOTIFIER_RESPONSE_BUDGET_MS: "10",
    },
    callFunctionImpl() {
      invocationStarted = true;
      return new Promise(() => {});
    },
  });
  const startedAt = Date.now();
  const result = await main({
    action: "submitInquiry",
    inquiry: {
      inquirySchemaVersion: 2,
      packageTypes: ["礼盒"],
      content: "希望做企业纪念礼盒",
      contact: "wx-test",
      contactType: "wechat",
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.alertStatus, "deferred");
  assert.equal(invocationStarted, true);
  assert.equal(added.some((item) => item.collectionName === "inquiries"), true);
  assert.equal(Date.now() - startedAt < 250, true);
});

await test("reply subscription is bound to the owned inquiry and server openid", async () => {
  const templateId = "reply_template_id_123456789012345";
  const { main, recordsByCollection } = loadUserDataFunction({
    openid: "customer_a",
    env: {
      INQUIRY_FOLLOWUP_ENABLED: "true",
      INQUIRY_CUSTOMER_PUSH_ENABLED: "true",
      INQUIRY_REPLY_TEMPLATE_ID: templateId,
      INQUIRY_REPLY_TEMPLATE_FIELDS: JSON.stringify({
        title: "thing1",
        time: "time2",
        content: "thing3",
      }),
    },
    recordsByCollection: {
      inquiries: [{ _id: "inquiry_a", openid: "customer_a" }],
    },
  });
  const result = await main({
    action: "saveInquiryReplySubscription",
    id: "inquiry_a",
    templateId,
    status: "accept",
    openid: "spoofed",
  });
  assert.equal(result.ok, true);
  const subscriptions = recordsByCollection.inquiry_reply_subscriptions;
  assert.equal(subscriptions.length, 1);
  assert.equal(
    subscriptions[0]._id,
    logic.buildInquiryReplySubscriptionId("inquiry_a", "customer_a")
  );
  assert.equal(subscriptions[0].openid, "customer_a");
  assert.equal(subscriptions[0].status, "granted");
});

await test("repeated reply grants upsert one deterministic subscription document", async () => {
  const templateId = "reply_template_id_123456789012345";
  const { main, recordsByCollection } = loadUserDataFunction({
    openid: "customer_a",
    env: {
      INQUIRY_FOLLOWUP_ENABLED: "true",
      INQUIRY_CUSTOMER_PUSH_ENABLED: "true",
      INQUIRY_REPLY_TEMPLATE_ID: templateId,
      INQUIRY_REPLY_TEMPLATE_FIELDS: JSON.stringify({
        title: "thing1",
        time: "time2",
        content: "thing3",
      }),
    },
    recordsByCollection: {
      inquiries: [{ _id: "inquiry_a", openid: "customer_a" }],
    },
  });
  const request = {
    action: "saveInquiryReplySubscription",
    id: "inquiry_a",
    templateId,
    status: "accept",
  };
  const [first, second] = await Promise.all([main(request), main(request)]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(recordsByCollection.inquiry_reply_subscriptions.length, 1);
  assert.equal(
    recordsByCollection.inquiry_reply_subscriptions[0]._id,
    logic.buildInquiryReplySubscriptionId("inquiry_a", "customer_a")
  );
});

await test("reply grants keep updating legacy generated subscription IDs", async () => {
  const templateId = "reply_template_id_123456789012345";
  const legacy = {
    _id: "legacy_generated_id",
    inquiryId: "inquiry_a",
    openid: "customer_a",
    templateId,
    status: "consumed",
    createdAt: "legacy-created-at",
  };
  const { main, recordsByCollection } = loadUserDataFunction({
    openid: "customer_a",
    env: {
      INQUIRY_FOLLOWUP_ENABLED: "true",
      INQUIRY_CUSTOMER_PUSH_ENABLED: "true",
      INQUIRY_REPLY_TEMPLATE_ID: templateId,
      INQUIRY_REPLY_TEMPLATE_FIELDS: JSON.stringify({
        title: "thing1",
        time: "time2",
        content: "thing3",
      }),
    },
    recordsByCollection: {
      inquiries: [{ _id: "inquiry_a", openid: "customer_a" }],
      inquiry_reply_subscriptions: [legacy],
    },
  });
  const result = await main({
    action: "saveInquiryReplySubscription",
    id: "inquiry_a",
    templateId,
    status: "accept",
  });
  const subscriptions = recordsByCollection.inquiry_reply_subscriptions;
  assert.equal(result.ok, true);
  assert.equal(subscriptions.length, 1);
  assert.equal(subscriptions[0]._id, "legacy_generated_id");
  assert.equal(subscriptions[0].status, "granted");
  assert.equal(subscriptions[0].createdAt, "legacy-created-at");
});

await test("reply subscription stays disabled when template fields are missing", async () => {
  const templateId = "reply_template_id_123456789012345";
  const { main, added } = loadUserDataFunction({
    openid: "customer_a",
    env: {
      INQUIRY_FOLLOWUP_ENABLED: "true",
      INQUIRY_CUSTOMER_PUSH_ENABLED: "true",
      INQUIRY_REPLY_TEMPLATE_ID: templateId,
    },
    recordsByCollection: {
      inquiries: [{ _id: "inquiry_a", openid: "customer_a" }],
    },
  });
  const result = await main({
    action: "saveInquiryReplySubscription",
    id: "inquiry_a",
    templateId,
    status: "accept",
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_TEMPLATE_CONFIG");
  assert.equal(
    added.some((item) => item.collectionName === "inquiry_reply_subscriptions"),
    false
  );
});

await test("submitFeedback stores contact type and minimizes system information", async () => {
  const { main, added } = loadUserDataFunction({
    openid: "server_openid",
  });

  const result = await main({
    action: "submitFeedback",
    feedback: {
      type: "suggestion",
      content: "希望案例筛选更方便",
      contact: "user@example.com",
      contactType: "email",
    },
    systemInfo: {
      brand: "Apple",
      model: "iPhone",
      platform: "ios",
      system: "iOS 19",
      version: "8.0.60",
      SDKVersion: "3.10.0",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(added[0].collectionName, "feedback");
  assert.equal(added[0].payload.data.openid, "server_openid");
  assert.equal(added[0].payload.data.contact, "user@example.com");
  assert.equal(added[0].payload.data.contactType, "email");
  assert.deepEqual(JSON.parse(JSON.stringify(added[0].payload.data.systemInfo)), {
    platform: "ios",
    system: "iOS 19",
    version: "8.0.60",
    SDKVersion: "3.10.0",
  });
});

await test("getProfile only queries the server openid", async () => {
  const { main, calls } = loadUserDataFunction({
    openid: "server_openid",
    records: [{ _id: "profile_1", openid: "server_openid", nickname: "酒友", avatarFileId: "cloud://avatar" }],
  });

  const result = await main({ action: "getProfile", openid: "spoofed" });

  assert.deepEqual(JSON.parse(JSON.stringify(result.profile)), {
    nickname: "酒友",
    avatarFileId: "cloud://avatar",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), {
    collectionName: "user_profiles",
    type: "where",
    condition: { openid: "server_openid" },
  });
});

await test("getSessionSummary returns profile, avatar and independent admin roles", async () => {
  const { main, calls } = loadUserDataFunction({
    openid: "case_admin",
    env: {
      ADMIN_OPENIDS: "legacy_admin",
      INQUIRY_ADMIN_OPENIDS: "inquiry_admin",
      CASE_ADMIN_OPENIDS: "case_admin",
      NOTIFICATION_ADMIN_OPENIDS: "notification_admin",
    },
    records: [{
      _id: "profile_1",
      openid: "case_admin",
      nickname: "酒友",
      avatarFileId: "cloud://env/avatar.jpg",
    }],
  });

  const result = await main({
    action: "getSessionSummary",
    openid: "spoofed",
  });

  assert.equal(result.ok, true);
  assert.equal(result.openid, "case_admin");
  assert.equal(result.profile.nickname, "酒友");
  assert.equal(result.profile.avatarUrl, "https://temp/cloud%3A%2F%2Fenv%2Favatar.jpg");
  assert.deepEqual(JSON.parse(JSON.stringify(result.roles)), {
    inquiryAdmin: false,
    caseAdmin: true,
    notificationAdmin: false,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].condition)), {
    openid: "case_admin",
  });
});

await test("session role configuration falls back to ADMIN_OPENIDS", async () => {
  const { main } = loadUserDataFunction({
    openid: "legacy_admin",
    env: {
      ADMIN_OPENIDS: "legacy_admin",
    },
  });
  const result = await main({ action: "getSessionSummary" });
  assert.deepEqual(JSON.parse(JSON.stringify(result.roles)), {
    inquiryAdmin: true,
    caseAdmin: true,
    notificationAdmin: true,
  });
});

await test("blank role configuration also falls back to ADMIN_OPENIDS", async () => {
  const { main } = loadUserDataFunction({
    openid: "legacy_admin",
    env: {
      ADMIN_OPENIDS: " legacy_admin ",
      INQUIRY_ADMIN_OPENIDS: "   ",
      CASE_ADMIN_OPENIDS: "",
      NOTIFICATION_ADMIN_OPENIDS: "   ",
    },
  });
  const result = await main({ action: "getSessionSummary" });
  assert.deepEqual(JSON.parse(JSON.stringify(result.roles)), {
    inquiryAdmin: true,
    caseAdmin: true,
    notificationAdmin: true,
  });
});

await test("saveProfile creates a profile with server openid only", async () => {
  const { main, added } = loadUserDataFunction({ openid: "server_openid" });

  const result = await main({
    action: "saveProfile",
    profile: {
      nickname: "酒友",
      avatarFileId: "cloud://avatar",
      openid: "spoofed",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(added[0].collectionName, "user_profiles");
  assert.equal(added[0].payload.data.openid, "server_openid");
  assert.deepEqual(JSON.parse(JSON.stringify(result.profile)), {
    nickname: "酒友",
    avatarFileId: "cloud://avatar",
  });
});
