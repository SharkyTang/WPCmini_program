import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(
  __dirname,
  "../miniprogram/miniprogram/utils/notificationData.js"
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
  normalizeNotifications,
  normalizeDisabledTypes,
  isNotificationTypeDisabled,
  toggleDisabledType,
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
  assert.equal(getNotificationTypeLabel("customer_reply"), "客服回复");
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

test("normalizes disabled types and ignores invalid values", () => {
  const disabled = normalizeDisabledTypes([
    "product_new",
    "",
    "unknown",
    "product_new",
    "customer_reply",
  ]);

  assert.deepEqual(plain(disabled), ["product_new", "customer_reply"]);
});

test("detects and toggles disabled notification types", () => {
  assert.equal(isNotificationTypeDisabled(["product_new"], "product_new"), true);
  assert.equal(isNotificationTypeDisabled(["product_new"], "version_update"), false);

  assert.deepEqual(plain(toggleDisabledType(["product_new"], "product_new")), []);
  assert.deepEqual(plain(toggleDisabledType(["product_new"], "customer_reply")), [
    "product_new",
    "customer_reply",
  ]);
});
