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
  validateSubscriptionGrant,
  validateUserProfileDraft,
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
    contactType: "wechat",
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
  assert.equal(record.contactType, "wechat");
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

test("validates contact types while accepting legacy clients", () => {
  const inquiry = {
    packageTypes: ["礼盒"],
    content: "想做一套礼盒包装",
  };
  assert.equal(validateInquiryDraft({ ...inquiry, contact: "legacy-contact" }).valid, true);
  assert.equal(
    validateInquiryDraft({ ...inquiry, contact: "12345", contactType: "phone" }).message,
    "请输入正确的手机号"
  );
  assert.equal(
    validateInquiryDraft({ ...inquiry, contact: "user@example.com", contactType: "email" }).valid,
    true
  );
  assert.equal(
    validateFeedbackDraft({
      type: "bug",
      content: "页面加载异常",
      contact: "user@invalid",
      contactType: "email",
    }).message,
    "请输入正确的邮箱"
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
    systemInfo: {
      brand: "Apple",
      model: "iPhone",
      platform: "ios",
      system: "iOS 19",
      version: "8.0.60",
      SDKVersion: "3.10.0",
    },
  });

  assert.equal(validation.valid, true);
  assert.equal(record.openid, "server_openid");
  assert.equal(record.status, "new");
  assert.deepEqual(plain(record.systemInfo), {
    platform: "ios",
    system: "iOS 19",
    version: "8.0.60",
    SDKVersion: "3.10.0",
  });
});

test("validates subscription grants against the configured template", () => {
  const templates = {
    version_update: "version_template_id_1234567890",
    product_new: "product_template_id_1234567890",
  };
  assert.deepEqual(
    plain(validateSubscriptionGrant({
      type: "product_new",
      templateId: "product_template_id_1234567890",
      status: "accept",
    }, templates)),
    {
      valid: true,
      data: {
        type: "product_new",
        templateId: "product_template_id_1234567890",
        status: "granted",
      },
    }
  );
  assert.equal(
    validateSubscriptionGrant({
      type: "customer_reply",
      templateId: "legacy",
      status: "accept",
    }, templates).code,
    "INVALID_SUBSCRIPTION"
  );
  assert.equal(
    validateSubscriptionGrant({
      type: "product_new",
      templateId: "wrong",
      status: "accept",
    }, templates).code,
    "INVALID_TEMPLATE"
  );
  assert.equal(logic.isValidSubscriptionTemplateId("10103"), false);
  assert.equal(
    logic.buildTemplateConfig("product_new", "1330").envKey,
    "PRODUCT_NEW_TEMPLATE_ID"
  );
});

test("validates profile nickname and cloud avatar file id", () => {
  assert.equal(validateUserProfileDraft({ nickname: "", avatarFileId: "cloud://avatar" }).message, "请输入昵称");
  assert.equal(
    validateUserProfileDraft({ nickname: "昵称", avatarFileId: "/tmp/avatar.png" }).message,
    "请先选择头像"
  );
  assert.equal(
    validateUserProfileDraft({ nickname: "名".repeat(15), avatarFileId: "cloud://avatar" }).message,
    "昵称最多 14 个字符"
  );
  assert.deepEqual(
    plain(validateUserProfileDraft({ nickname: "  酒友  ", avatarFileId: "cloud://avatar" }).data),
    { nickname: "酒友", avatarFileId: "cloud://avatar" }
  );
});
