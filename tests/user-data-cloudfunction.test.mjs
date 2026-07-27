import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const logic = require(resolve(
  __dirname,
  "../miniprogram/cloudfunctions/userData/userDataLogic.js"
));

const {
  buildFeedbackRecord,
  buildInquiryRecord,
  normalizeDisabledTypes,
  validateFeedbackDraft,
  validateInquiryDraft,
} = logic;

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

test("builds inquiry records from whitelisted fields and server openid", () => {
  const validation = validateInquiryDraft({
    packageTypes: ["礼盒"],
    content: "想做一套礼盒包装",
    contact: "wx-test",
    openid: "spoofed",
    status: "done",
    adminNote: "bad",
  });
  const record = buildInquiryRecord(validation.data, {
    openid: "server_openid",
    sourcePage: "pages/inquiry/index",
  });

  assert.equal(validation.valid, true);
  assert.equal(record.openid, "server_openid");
  assert.equal(record.status, "new");
  assert.equal(Object.prototype.hasOwnProperty.call(record, "adminNote"), false);
});

test("validates feedback type, content, and contact length", () => {
  assert.equal(validateFeedbackDraft({ type: "unknown", content: "页面加载异常" }).message, "请选择反馈类型");
  assert.equal(validateFeedbackDraft({ type: "bug", content: "卡" }).message, "请至少填写 5 个字");
  assert.equal(
    validateFeedbackDraft({
      type: "bug",
      content: "页面加载异常",
      contact: "1".repeat(121),
    }).message,
    "联系方式最多 120 个字"
  );
});

test("builds feedback records without trusting client identity fields", () => {
  const validation = validateFeedbackDraft({
    type: "bug",
    content: "页面加载时偶尔卡顿",
    contact: "wx-test",
    openid: "spoofed",
  });
  const record = buildFeedbackRecord(validation.data, {
    openid: "server_openid",
    route: "pages/feedback/index",
  });

  assert.equal(validation.valid, true);
  assert.equal(record.openid, "server_openid");
  assert.equal(record.status, "new");
  assert.deepEqual(plain(record.systemInfo), {});
});

test("normalizes notification preference disabled types", () => {
  assert.deepEqual(
    plain(normalizeDisabledTypes(["product_new", "unknown", "product_new", "customer_reply"])),
    ["product_new", "customer_reply"]
  );
});
