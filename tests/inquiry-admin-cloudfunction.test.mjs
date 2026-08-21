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
  "../miniprogram/cloudfunctions/inquiryAdmin/index.js"
);
const logic = require(resolve(
  __dirname,
  "../miniprogram/cloudfunctions/inquiryAdmin/inquiryAdminLogic.js"
));
const FIXED_DATE = new Date("2026-08-21T06:00:00.000Z");
const INTERNAL_TOKEN = "test-inquiry-notifier-internal-token-20260821";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function createNotFoundError() {
  const error = new Error("document not found");
  error.code = "DATABASE_DOCUMENT_NOT_EXIST";
  return error;
}

function matches(record, condition = {}) {
  if (condition && condition.operator === "and") {
    return condition.values.every((value) => matches(record, value));
  }
  if (condition && condition.operator === "or") {
    return condition.values.some((value) => matches(record, value));
  }
  return Object.entries(condition).every(([key, expected]) => {
    const matchesExpected = (actual, expectedValue, exists) => {
      if (expectedValue && expectedValue.operator === "and") {
        return expectedValue.values.every((value) => (
          matchesExpected(actual, value, exists)
        ));
      }
      if (expectedValue && expectedValue.operator === "neq") {
        return actual !== expectedValue.value;
      }
      if (expectedValue && expectedValue.operator === "exists") {
        return expectedValue.value ? exists : !exists;
      }
      if (expectedValue && expectedValue.operator === "lt") {
        if (key === "createdAt") {
          return toTimestamp(actual) < toTimestamp(expectedValue.value);
        }
        return String(actual || "") < String(expectedValue.value || "");
      }
      if (expectedValue && expectedValue.operator === "regexp") {
        return new RegExp(
          expectedValue.pattern,
          expectedValue.options
        ).test(String(actual || ""));
      }
      if (actual instanceof Date || expectedValue instanceof Date) {
        return toTimestamp(actual) === toTimestamp(expectedValue);
      }
      return actual === expectedValue;
    };
    if (expected && expected.operator === "in") {
      return expected.values.includes(record[key]);
    }
    const exists = Object.prototype.hasOwnProperty.call(record, key)
      && record[key] !== undefined;
    return matchesExpected(record[key], expected, exists);
  });
}

function toTimestamp(value) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function loadInquiryAdmin(options = {}) {
  const collections = clone(options.collections || {});
  const context = { openid: options.openid || "admin_a" };
  const sends = [];
  const calls = { transactions: 0, functions: [], skips: 0 };
  const sendImpl = options.sendImpl || (async () => ({}));

  function createCollection(name) {
    const records = collections[name] || (collections[name] = []);
    const state = {
      condition: null,
      orders: [],
      skip: 0,
      limit: Infinity,
    };
    const api = {
      where(condition) {
        state.condition = condition;
        return api;
      },
      orderBy(field, direction) {
        state.orders.push({ field, direction });
        return api;
      },
      skip(value) {
        calls.skips += 1;
        state.skip = value;
        return api;
      },
      limit(value) {
        state.limit = value;
        return api;
      },
      async count() {
        const filtered = state.condition
          ? records.filter((record) => matches(record, state.condition))
          : records;
        return { total: filtered.length };
      },
      async get() {
        let filtered = state.condition
          ? records.filter((record) => matches(record, state.condition))
          : [...records];
        if (state.orders.length) {
          filtered.sort((left, right) => {
            for (const order of state.orders) {
              const multiplier = order.direction === "desc" ? -1 : 1;
              const leftValue = order.field === "createdAt"
                ? toTimestamp(left[order.field])
                : String(left[order.field] || "");
              const rightValue = order.field === "createdAt"
                ? toTimestamp(right[order.field])
                : String(right[order.field] || "");
              if (leftValue === rightValue) continue;
              return (leftValue < rightValue ? -1 : 1) * multiplier;
            }
            return 0;
          });
        }
        return {
          data: clone(filtered.slice(state.skip, state.skip + state.limit)),
        };
      },
      doc(id) {
        return {
          async get() {
            const record = records.find((item) => item._id === id);
            if (!record) throw createNotFoundError();
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
            if (!record) throw createNotFoundError();
            Object.assign(record, clone(payload.data || {}));
            return {};
          },
        };
      },
    };
    return api;
  }

  const database = {
    command: {
      exists(value) {
        return { operator: "exists", value };
      },
      neq(value) {
        const command = {
          operator: "neq",
          value,
          and(...values) {
            return { operator: "and", values: [command, ...values] };
          },
        };
        return command;
      },
      in(values) {
        return { operator: "in", values };
      },
      lt(value) {
        return { operator: "lt", value };
      },
      and(...values) {
        return {
          operator: "and",
          values: Array.isArray(values[0]) ? values[0] : values,
        };
      },
      or(...values) {
        return {
          operator: "or",
          values: Array.isArray(values[0]) ? values[0] : values,
        };
      },
    },
    RegExp({ regexp, options }) {
      return { operator: "regexp", pattern: regexp, options: options || "" };
    },
    collection: createCollection,
    serverDate() {
      return new Date(FIXED_DATE);
    },
    async runTransaction(handler) {
      calls.transactions += 1;
      return handler({ collection: createCollection });
    },
  };
  const cloud = {
    DYNAMIC_CURRENT_ENV: "dynamic-env",
    init() {},
    database() {
      return database;
    },
    getWXContext() {
      return { OPENID: context.openid };
    },
    async callFunction(payload) {
      calls.functions.push(clone(payload));
      if (options.healthError) throw options.healthError;
      return clone(options.healthResponse || {
        result: { ok: true, status: "ready", reason: "" },
      });
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
    console: { error() {}, warn() {} },
    Date,
    process: {
      env: {
        ADMIN_OPENIDS: options.adminOpenids || "admin_a,admin_b",
        INQUIRY_ADMIN_OPENIDS: options.inquiryAdminOpenids || "",
        INQUIRY_FOLLOWUP_ENABLED: options.followupEnabled === undefined
          ? "true"
          : options.followupEnabled,
        INQUIRY_EMAIL_ALERTS_ENABLED: options.emailAlertsEnabled === undefined
          ? "true"
          : options.emailAlertsEnabled,
        INQUIRY_CUSTOMER_PUSH_ENABLED: options.pushEnabled || "false",
        INQUIRY_NOTIFIER_INTERNAL_TOKEN: options.internalToken === undefined
          ? INTERNAL_TOKEN
          : options.internalToken,
        INQUIRY_REPLY_TEMPLATE_ID: options.templateId || "",
        INQUIRY_REPLY_TEMPLATE_FIELDS: options.templateFields || "",
        SUBSCRIBE_MESSAGE_STATE: options.miniprogramState || "developer",
      },
    },
    require(moduleName) {
      if (moduleName === "wx-server-sdk") return cloud;
      if (moduleName === "crypto") return require("node:crypto");
      if (moduleName === "./inquiryAdminLogic") return logic;
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
    sends,
    calls,
    setOpenid(openid) {
      context.openid = openid;
    },
  };
}

function buildCollections(overrides = {}) {
  return {
    inquiries: [{
      _id: "inquiry_1",
      openid: "customer_real",
      contact: "customer_wechat",
      contactType: "wechat",
      status: "new",
      createdAt: new Date("2026-08-21T05:00:00.000Z"),
    }],
    inquiry_messages: [],
    inquiry_admin_events: [],
    inquiry_alert_jobs: [],
    inquiry_reply_subscriptions: [],
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

await test("new actions keep admin authorization at the cloud boundary", async () => {
  const loaded = loadInquiryAdmin({ openid: "visitor" });
  for (const action of [
    "getInquirySummary",
    "claimInquiry",
    "takeOverInquiry",
    "replyInquiry",
    "correctContactType",
  ]) {
    const result = await loaded.main({ action, id: "inquiry_1" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "FORBIDDEN");
  }
  assert.equal(loaded.calls.transactions, 0);
});

await test("follow-up switch gates claim and reply but not data correction", async () => {
  const loaded = loadInquiryAdmin({
    collections: buildCollections(),
    followupEnabled: "false",
    pushEnabled: "true",
  });
  const access = await loaded.main({ action: "checkAccess" });
  assert.equal(access.followupEnabled, false);
  assert.equal(access.customerPushEnabled, false);
  for (const action of ["claimInquiry", "takeOverInquiry", "replyInquiry"]) {
    const result = await loaded.main({
      action,
      id: "inquiry_1",
      content: "回复",
      clientMutationId: "disabled-1",
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "FEATURE_DISABLED");
  }
  assert.equal(loaded.calls.transactions, 0);

  const correction = await loaded.main({
    action: "correctContactType",
    id: "inquiry_1",
    contactType: "phone",
  });
  assert.equal(correction.ok, true);
  assert.equal(loaded.collections.inquiries[0].contactType, "phone");
});

await test("legacy list, detail, status, and note actions remain compatible", async () => {
  const loaded = loadInquiryAdmin({ collections: buildCollections({
    inquiry_messages: [{
      _id: "message_1",
      id: "message_1",
      inquiryId: "inquiry_1",
      direction: "admin_to_customer",
      content: "已添加您的微信",
      createdAt: new Date("2026-08-21T05:30:00.000Z"),
      createdByOpenid: "admin_a",
    }],
  }) });
  const list = await loaded.main({ action: "listInquiries" });
  assert.equal(list.ok, true);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].claim, null);

  const detail = await loaded.main({ action: "getInquiry", id: "inquiry_1" });
  assert.equal(detail.ok, true);
  assert.equal(detail.item._id, "inquiry_1");
  assert.equal(detail.messages.length, 1);
  assert.equal(detail.messages[0].id, "message_1");

  assert.equal((await loaded.main({
    action: "updateInquiryStatus",
    id: "inquiry_1",
    status: "processing",
  })).status, "processing");
  const invalidStatus = await loaded.main({
    action: "updateInquiryStatus",
    id: "inquiry_1",
    status: "unexpected_status",
  });
  assert.equal(invalidStatus.ok, false);
  assert.equal(invalidStatus.code, "INVALID_STATUS");
  assert.equal((await loaded.main({
    action: "saveInquiryNote",
    id: "inquiry_1",
    adminNote: " 电话已沟通 ",
  })).adminNote, "电话已沟通");
  assert.equal(loaded.collections.inquiries[0].status, "processing");
  assert.equal(loaded.collections.inquiries[0].adminNote, "电话已沟通");
});

await test("summary returns exact status, unclaimed, and mine counts", async () => {
  const loaded = loadInquiryAdmin({ collections: buildCollections({
    inquiries: [
      { _id: "1", status: "new", claimedByOpenid: "", claimedBy: "" },
      {
        _id: "2",
        status: "contacted",
        claimedByOpenid: "admin_a",
        claimedBy: "admin_a",
      },
      { _id: "3", status: "processing", claimedBy: "admin_b" },
      { _id: "4", status: "done" },
      { _id: "5", status: "invalid" },
    ],
    inquiry_alert_jobs: [
      { _id: "j1", status: "permanent_failed" },
      { _id: "j2", status: "delivery_unknown" },
      { _id: "j3", status: "sent" },
    ],
  }) });
  const result = await loaded.main({ action: "getInquirySummary" });
  assert.equal(result.ok, true);
  assert.equal(result.total, 5);
  assert.equal(result.newCount, 1);
  assert.equal(result.contactedCount, 1);
  assert.equal(result.processingCount, 1);
  assert.equal(result.doneCount, 1);
  assert.equal(result.invalidCount, 1);
  assert.equal(result.unclaimedCount, 3);
  assert.equal(result.mineCount, 1);
  assert.equal(result.emailAlertIssueCount, 2);
  assert.equal(result.followupEnabled, true);
  assert.equal(result.emailAlertsEnabled, true);
  assert.equal(result.customerPushEnabled, false);
  assert.equal(result.emailNotifierStatus, "ready");
  assert.equal(result.emailNotifierReason, "");
  assert.deepEqual(loaded.calls.functions, [{
    name: "inquiryNotifier",
    data: { action: "health", internalToken: INTERNAL_TOKEN },
  }]);
});

await test("disabled email alerts skip notifier health and issue counts", async () => {
  const loaded = loadInquiryAdmin({
    emailAlertsEnabled: "false",
    healthError: new Error("should not be called"),
    collections: buildCollections({
      inquiry_alert_jobs: [{ _id: "j1", status: "permanent_failed" }],
    }),
  });
  const result = await loaded.main({ action: "getInquirySummary" });
  assert.equal(result.ok, true);
  assert.equal(result.followupEnabled, true);
  assert.equal(result.emailAlertsEnabled, false);
  assert.equal(result.emailAlertIssueCount, 0);
  assert.equal(result.emailNotifierStatus, "disabled");
  assert.deepEqual(loaded.calls.functions, []);
});

await test("summary survives an unavailable notifier health check", async () => {
  const loaded = loadInquiryAdmin({
    collections: buildCollections(),
    healthError: new Error("function unavailable"),
  });
  const result = await loaded.main({ action: "getInquirySummary" });
  assert.equal(result.ok, true);
  assert.equal(result.emailNotifierStatus, "unknown");
  assert.equal(result.emailNotifierReason, "health_unavailable");
});

await test("list supports unclaimed and mine filters with status compatibility", async () => {
  const loaded = loadInquiryAdmin({ collections: buildCollections({
    inquiries: [
      { _id: "1", status: "new", createdAt: new Date("2026-08-21T05:04:00Z") },
      { _id: "2", status: "processing", claimedBy: "admin_a", createdAt: new Date("2026-08-21T05:03:00Z") },
      { _id: "3", status: "new", claimedByOpenid: "admin_a", createdAt: new Date("2026-08-21T05:02:00Z") },
      { _id: "4", status: "new", claimedBy: "admin_b", createdAt: new Date("2026-08-21T05:01:00Z") },
    ],
  }) });
  const unclaimed = await loaded.main({
    action: "listInquiries",
    filter: "unclaimed",
  });
  assert.deepEqual(Array.from(unclaimed.items, (item) => item._id), ["1"]);
  const mine = await loaded.main({
    action: "listInquiries",
    filter: "mine",
    status: "new",
  });
  assert.deepEqual(Array.from(mine.items, (item) => item._id), ["3"]);
});

await test("status and keyword searches do not lose matches older than 200 rows", async () => {
  const inquiries = Array.from({ length: 250 }, (_, index) => ({
    _id: `inquiry_${index}`,
    status: index === 249 ? "new" : "done",
    content: index === 249 ? "old-enterprise-lead" : `ordinary-${index}`,
    createdAt: new Date(Date.UTC(2026, 7, 21, 5, 0, 0) - index * 1000),
  }));
  const loaded = loadInquiryAdmin({ collections: buildCollections({ inquiries }) });
  const byStatus = await loaded.main({
    action: "listInquiries",
    status: "new",
  });
  assert.deepEqual(Array.from(byStatus.items, (item) => item._id), ["inquiry_249"]);

  const byKeyword = await loaded.main({
    action: "listInquiries",
    keyword: "enterprise-lead",
  });
  assert.deepEqual(Array.from(byKeyword.items, (item) => item._id), ["inquiry_249"]);
});

await test("cursor list pushes filters into the database and preserves equal timestamps", async () => {
  const sameTime = new Date("2026-08-21T05:00:00.000Z");
  const inquiries = [
    { _id: "same_c", status: "new", claimedByOpenid: "admin_a", contact: "WX-Enterprise-C", createdAt: sameTime },
    { _id: "same_b", status: "new", claimedByOpenid: "admin_a", contact: "WX-Enterprise-B", createdAt: sameTime },
    { _id: "same_a", status: "new", claimedByOpenid: "admin_a", contact: "WX-Enterprise-A", createdAt: sameTime },
    { _id: "older", status: "new", claimedByOpenid: "admin_a", contact: "WX-Enterprise-Old", createdAt: new Date("2026-08-21T04:59:00.000Z") },
    { _id: "other", status: "done", claimedByOpenid: "admin_a", contact: "WX-Enterprise-Other", createdAt: new Date("2026-08-21T05:01:00.000Z") },
  ];
  const loaded = loadInquiryAdmin({ collections: buildCollections({ inquiries }) });
  const first = await loaded.main({
    action: "listInquiries",
    status: "new",
    filter: "mine",
    keyword: "enterprise",
    cursor: "",
    pageSize: 2,
  });
  const second = await loaded.main({
    action: "listInquiries",
    status: "new",
    filter: "mine",
    keyword: "enterprise",
    cursor: first.nextCursor,
    pageSize: 2,
  });
  assert.deepEqual(
    [...first.items, ...second.items].map((item) => item._id),
    ["same_c", "same_b", "same_a", "older"]
  );
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, false);
  assert.equal(loaded.calls.skips, 0);
});

await test("claim is conditional, takeover is explicit, and alerts stop", async () => {
  const loaded = loadInquiryAdmin({ collections: buildCollections({
    inquiry_alert_jobs: [
      { _id: "job_pending", inquiryId: "inquiry_1", status: "pending" },
      { _id: "job_sent", inquiryId: "inquiry_1", status: "sent" },
      { _id: "job_unknown", inquiryId: "inquiry_1", status: "delivery_unknown" },
    ],
  }) });
  const claimed = await loaded.main({ action: "claimInquiry", id: "inquiry_1" });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.claim.claimedBy, "admin_a");
  assert.equal(claimed.claim.claimedByOpenid, "admin_a");
  assert.equal(loaded.collections.inquiries[0].claimedByOpenid, "admin_a");
  assert.equal(loaded.collections.inquiries[0].claimedBy, "admin_a");
  assert.equal(loaded.collections.inquiry_alert_jobs[0].status, "cancelled");
  assert.equal(loaded.collections.inquiry_alert_jobs[0].stopReason, "claimed");
  assert.equal(loaded.collections.inquiry_alert_jobs[1].status, "sent");
  assert.equal(loaded.collections.inquiry_alert_jobs[2].status, "delivery_unknown");
  assert.equal(loaded.collections.inquiry_admin_events.length, 1);

  const duplicate = await loaded.main({ action: "claimInquiry", id: "inquiry_1" });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.idempotent, true);
  assert.equal(loaded.collections.inquiry_admin_events.length, 1);

  loaded.setOpenid("admin_b");
  const conflict = await loaded.main({ action: "claimInquiry", id: "inquiry_1" });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, "CLAIM_CONFLICT");
  assert.equal(loaded.collections.inquiries[0].claimedBy, "admin_a");

  const takenOver = await loaded.main({
    action: "takeOverInquiry",
    id: "inquiry_1",
    expectedClaimedBy: "admin_a",
  });
  assert.equal(takenOver.ok, true);
  assert.equal(takenOver.takenOver, true);
  assert.equal(loaded.collections.inquiries[0].claimedByOpenid, "admin_b");
  assert.equal(loaded.collections.inquiries[0].claimedBy, "admin_b");
  assert.equal(loaded.collections.inquiry_admin_events.length, 2);
  assert.equal(loaded.collections.inquiry_admin_events[1].before.claimedBy, "admin_a");

  loaded.setOpenid("admin_a");
  const staleTakeover = await loaded.main({
    action: "takeOverInquiry",
    id: "inquiry_1",
    expectedClaimedBy: "admin_a",
  });
  assert.equal(staleTakeover.ok, false);
  assert.equal(staleTakeover.code, "CLAIM_CONFLICT");
  assert.equal(staleTakeover.claim.claimedBy, "admin_b");
  assert.equal(loaded.collections.inquiries[0].claimedBy, "admin_b");
});

await test("first reply atomically claims, changes new to contacted, and is idempotent", async () => {
  const loaded = loadInquiryAdmin({ collections: buildCollections({
    inquiry_alert_jobs: [{
      _id: "job_1",
      inquiryId: "inquiry_1",
      status: "processing",
      leaseOwner: "worker",
    }],
  }) });
  const request = {
    action: "replyInquiry",
    id: "inquiry_1",
    content: "  已添加您微信，麻烦看一下  ",
    clientMutationId: "reply-001",
  };
  const first = await loaded.main(request);
  assert.equal(first.ok, true);
  assert.equal(first.status, "contacted");
  assert.equal(first.claim.claimedBy, "admin_a");
  assert.equal(first.idempotent, false);
  assert.equal(first.pushStatus, "disabled");
  assert.equal(Object.prototype.hasOwnProperty.call(first, "customerOpenid"), false);
  assert.equal(loaded.collections.inquiry_messages.length, 1);
  assert.equal(loaded.collections.inquiry_messages[0].customerOpenid, "customer_real");
  assert.equal(loaded.collections.inquiries[0].replyCount, 1);
  assert.equal(loaded.collections.inquiries[0].customerUnreadCount, 1);
  assert.equal(
    loaded.collections.inquiries[0].lastAdminReplyPreview,
    "已添加您微信，麻烦看一下"
  );
  assert.equal(loaded.collections.inquiries[0].firstReplyAt instanceof Date, true);
  assert.equal(loaded.collections.inquiry_admin_events.length, 1);
  assert.equal(loaded.collections.inquiry_alert_jobs[0].status, "cancelled");
  assert.equal(loaded.collections.inquiry_alert_jobs[0].stopReason, "replied");

  const duplicate = await loaded.main(request);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.idempotent, true);
  assert.equal(duplicate.message.id, first.message.id);
  assert.equal(loaded.collections.inquiry_messages.length, 1);
  assert.equal(loaded.collections.inquiry_admin_events.length, 1);
  assert.equal(loaded.collections.inquiries[0].replyCount, 1);

  const mismatch = await loaded.main({ ...request, content: "另一条回复" });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, "IDEMPOTENCY_CONFLICT");
  assert.equal(loaded.collections.inquiry_messages.length, 1);
});

await test("reply rejects forged recipients, invalid content, and another admin claim", async () => {
  const loaded = loadInquiryAdmin({ collections: buildCollections({
    inquiries: [{
      _id: "inquiry_1",
      openid: "customer_real",
      status: "new",
      claimedBy: "admin_b",
      claimedAt: FIXED_DATE,
    }],
  }) });
  const forged = await loaded.main({
    action: "replyInquiry",
    id: "inquiry_1",
    content: "ok",
    clientMutationId: "reply-forged",
    customerOpenid: "attacker_target",
  });
  assert.equal(forged.code, "FORBIDDEN_FIELD");
  const empty = await loaded.main({
    action: "replyInquiry",
    id: "inquiry_1",
    content: " ",
    clientMutationId: "reply-empty",
  });
  assert.equal(empty.code, "INVALID_REPLY");
  const conflict = await loaded.main({
    action: "replyInquiry",
    id: "inquiry_1",
    content: "请查看",
    clientMutationId: "reply-conflict",
  });
  assert.equal(conflict.code, "CLAIM_CONFLICT");
  assert.equal(loaded.collections.inquiry_messages.length, 0);
});

await test("contact correction records before and after values", async () => {
  const loaded = loadInquiryAdmin({ collections: buildCollections({
    inquiries: [{
      _id: "inquiry_1",
      openid: "customer_real",
      contact: "13800138000",
      contactType: "legacy_mobile",
      status: "new",
    }],
  }) });
  const invalid = await loaded.main({
    action: "correctContactType",
    id: "inquiry_1",
    contactType: "mobile",
  });
  assert.equal(invalid.code, "INVALID_CONTACT_TYPE");

  const corrected = await loaded.main({
    action: "correctContactType",
    id: "inquiry_1",
    contactType: "phone",
  });
  assert.equal(corrected.ok, true);
  assert.equal(corrected.previousContactType, "legacy_mobile");
  assert.equal(loaded.collections.inquiries[0].contactType, "phone");
  assert.equal(loaded.collections.inquiries[0].contactTypeSource, "admin_corrected");
  assert.equal(
    loaded.collections.inquiry_admin_events[0].before.contactType,
    "legacy_mobile"
  );
  assert.equal(loaded.collections.inquiry_admin_events[0].after.contactType, "phone");

  const duplicate = await loaded.main({
    action: "correctContactType",
    id: "inquiry_1",
    contactType: "phone",
  });
  assert.equal(duplicate.idempotent, true);
  assert.equal(loaded.collections.inquiry_admin_events.length, 1);
});

await test("reply push uses the inquiry owner and consumes one grant", async () => {
  const templateId = "valid_template_id_1234567890";
  const loaded = loadInquiryAdmin({
    collections: buildCollections({
      inquiry_reply_subscriptions: [{
        _id: "subscription_1",
        inquiryId: "inquiry_1",
        openid: "customer_real",
        templateId,
        status: "granted",
        grantedAt: new Date("2026-08-21T05:00:00.000Z"),
      }],
    }),
    pushEnabled: "true",
    templateId,
    templateFields: JSON.stringify({
      title: "thing1",
      time: "time2",
      content: "thing3",
    }),
    miniprogramState: "trial",
  });
  const request = {
    action: "replyInquiry",
    id: "inquiry_1",
    content: "这是私密回复正文",
    clientMutationId: "reply-push-1",
  };
  const result = await loaded.main(request);
  assert.equal(result.ok, true);
  assert.equal(result.pushStatus, "success");
  assert.equal(loaded.sends.length, 1);
  assert.equal(loaded.sends[0].touser, "customer_real");
  assert.equal(loaded.sends[0].page, "pages/my-inquiries/detail?id=inquiry_1");
  assert.equal(loaded.sends[0].miniprogramState, "trial");
  assert.equal(JSON.stringify(loaded.sends[0].data).includes("这是私密"), false);
  assert.equal(loaded.collections.inquiry_reply_subscriptions[0].status, "consumed");
  assert.equal(
    loaded.collections.inquiry_reply_subscriptions[0].lastDeliveryStatus,
    "success"
  );

  const subscription = loaded.collections.inquiry_reply_subscriptions[0];
  subscription.status = "granted";
  subscription.grantedAt = new Date("2026-08-21T05:10:00.000Z");
  const duplicate = await loaded.main(request);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.idempotent, true);
  assert.equal(Object.prototype.hasOwnProperty.call(duplicate, "pushStatus"), false);
  assert.equal(loaded.sends.length, 1);
  assert.equal(subscription.status, "granted");

  loaded.setOpenid("admin_b");
  const takeover = await loaded.main({
    action: "takeOverInquiry",
    id: "inquiry_1",
    expectedClaimedBy: "admin_a",
  });
  assert.equal(takeover.ok, true);
  loaded.setOpenid("admin_a");
  const staleReplay = await loaded.main(request);
  assert.equal(staleReplay.ok, false);
  assert.equal(staleReplay.code, "CLAIM_CONFLICT");
  assert.equal(loaded.sends.length, 1);
  assert.equal(subscription.status, "granted");
});

await test("push failure never rolls back a persisted reply", async () => {
  const templateId = "valid_template_id_1234567890";
  const loaded = loadInquiryAdmin({
    collections: buildCollections({
      inquiry_reply_subscriptions: [{
        _id: "subscription_1",
        inquiryId: "inquiry_1",
        openid: "customer_real",
        templateId,
        status: "granted",
        grantedAt: FIXED_DATE,
      }],
    }),
    pushEnabled: "true",
    templateId,
    templateFields: '{"title":"thing1"}',
    sendImpl: async () => {
      throw new Error("openapi unavailable");
    },
  });
  const result = await loaded.main({
    action: "replyInquiry",
    id: "inquiry_1",
    content: "站内回复必须保留",
    clientMutationId: "reply-push-failed",
  });
  assert.equal(result.ok, true);
  assert.equal(result.pushStatus, "failed");
  assert.equal(loaded.collections.inquiry_messages.length, 1);
  assert.equal(loaded.collections.inquiry_reply_subscriptions[0].status, "consumed");
  assert.equal(
    loaded.collections.inquiry_reply_subscriptions[0].lastDeliveryStatus,
    "failed"
  );
  assert.equal(
    loaded.collections.inquiry_reply_subscriptions[0].lastDeliveryErrorCode,
    "PUSH_FAILED"
  );
  assert.equal(
    loaded.collections.inquiry_reply_subscriptions[0].lastDeliveryError,
    "PUSH_FAILED"
  );
});

await test("a new grant created during push is not consumed by the prior delivery", async () => {
  const templateId = "template_reply_123456789012345";
  let loaded;
  loaded = loadInquiryAdmin({
    collections: buildCollections({
      inquiry_reply_subscriptions: [{
        _id: "subscription_1",
        inquiryId: "inquiry_1",
        openid: "customer_real",
        templateId,
        status: "granted",
      }],
    }),
    pushEnabled: "true",
    templateId,
    templateFields: JSON.stringify({ content: "thing1" }),
    async sendImpl() {
      // Simulate the customer granting the next one-time notification while
      // the previous OpenAPI request is still completing.
      const subscription = loaded.collections.inquiry_reply_subscriptions[0];
      subscription.status = "granted";
      subscription.grantedAt = new Date("2026-08-21T06:00:01.000Z");
      return {};
    },
  });
  const result = await loaded.main({
    action: "replyInquiry",
    id: "inquiry_1",
    content: "已添加您的好友",
    clientMutationId: "reply-regrant-race",
  });
  assert.equal(result.ok, true);
  assert.equal(result.pushStatus, "success");
  assert.equal(
    loaded.collections.inquiry_reply_subscriptions[0].status,
    "granted"
  );
});
