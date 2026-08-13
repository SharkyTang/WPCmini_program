import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/notifications/utils/notificationData.js"
);
const source = readFileSync(modulePath, "utf8");
const sandbox = {
  module: { exports: {} },
  exports: {},
  Date,
};
sandbox.exports = sandbox.module.exports;
vm.runInNewContext(source, sandbox, { filename: modulePath });

const {
  getNotificationTypeLabel,
  normalizeNotification,
  normalizeNotifications,
  normalizeSubscriptionState,
} = sandbox.module.exports;

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("maps notification type labels", () => {
  assert.equal(getNotificationTypeLabel("version_update"), "版本更新");
  assert.equal(getNotificationTypeLabel("product_new"), "产品上新");
  assert.equal(getNotificationTypeLabel("customer_reply"), "通知");
  assert.equal(getNotificationTypeLabel("unknown"), "通知");
});

test("filters hidden and unknown notifications", () => {
  const items = normalizeNotifications([
    { _id: "n1", type: "version_update", title: "可见", createdAt: "2026-06-30", isVisible: true },
    { _id: "n2", type: "product_new", title: "隐藏", createdAt: "2026-06-29", isVisible: false },
    { _id: "n3", type: "unknown", title: "未知", createdAt: "2026-06-28", isVisible: true },
  ]);

  assert.deepEqual(plain(items.map((item) => item.id)), ["n1"]);
});

test("sorts notifications by created time descending", () => {
  const items = normalizeNotifications([
    { _id: "old", type: "product_new", createdAt: "2026-06-01", sortOrder: 1 },
    { _id: "new", type: "version_update", createdAt: "2026-06-30", sortOrder: 2 },
    { _id: "same-day-first", type: "product_new", createdAt: "2026-06-30", sortOrder: 1 },
  ]);

  assert.deepEqual(plain(items.map((item) => item.id)), [
    "same-day-first",
    "new",
    "old",
  ]);
});

test("only linked product announcements expose a case entry", () => {
  const versionItem = normalizeNotification({
    _id: "version_1",
    type: "version_update",
    caseDocId: "legacy_case",
    targetPage: "/pages/detail/index?id=legacy_case",
  });
  const productItem = normalizeNotification({
    _id: "product_1",
    type: "product_new",
    caseDocId: "case_doc_1",
    targetPage: "/pages/detail/index?id=case_doc_1",
  });

  assert.equal(versionItem.hasCaseLink, false);
  assert.equal(productItem.hasCaseLink, true);
  assert.equal(
    productItem.targetPage,
    "/pages/notification-cases/index?announcementId=product_1"
  );
});

test("normalizes legacy delimited case ids into an ordered unique list", () => {
  const productItem = normalizeNotification({
    _id: "product_many",
    type: "product_new",
    caseDocId: "case_1，case_2; case_1 case_3",
  });
  assert.deepEqual(plain(productItem.caseDocIds), ["case_1", "case_2", "case_3"]);
  assert.equal(productItem.caseDocId, "case_1");
});

test("normalizes one-time subscription states for public notification types", () => {
  const state = normalizeSubscriptionState({
    product_new: {
      templateId: "product_template",
      status: "granted",
    },
    version_update: {
      templateId: "version_template",
      status: "unknown",
    },
    customer_reply: {
      templateId: "legacy",
      status: "granted",
    },
  });

  assert.deepEqual(plain(state), {
    version_update: {
      type: "version_update",
      templateId: "version_template",
      status: "idle",
      granted: false,
    },
    product_new: {
      type: "product_new",
      templateId: "product_template",
      status: "granted",
      granted: true,
    },
  });
});
