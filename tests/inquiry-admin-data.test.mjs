import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadCommonJsModule(modulePath) {
  const source = readFileSync(modulePath, "utf8");
  const sandbox = {
    module: { exports: {} },
    exports: {},
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(source, sandbox, { filename: modulePath });
  return sandbox.module.exports;
}

const inquiryAdminDataPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/inquiry-admin/utils/inquiryAdminData.js"
);
const inquiryAdminData = loadCommonJsModule(inquiryAdminDataPath);

const {
  ADMIN_NOTE_MAX_LENGTH,
  DEFAULT_INQUIRY_STATUS,
  getInquiryStatusLabel,
  getContactCopyLabel,
  getContactTypeLabel,
  normalizeAdminNote,
  normalizeInquiryAdminItem,
  normalizeInquiryKeyword,
  validateAdminNote,
} = inquiryAdminData;

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

test("normalizes missing inquiry status to new", () => {
  const item = normalizeInquiryAdminItem({
    _id: "inq_1",
    contact: " wx-test ",
    contactType: " wechat ",
    content: " 想做一套包装 ",
    packageTypes: ["礼盒", "整套包装"],
    createdAt: "2026-07-05",
  });

  assert.equal(item.id, "inq_1");
  assert.equal(item.status, DEFAULT_INQUIRY_STATUS);
  assert.equal(item.statusLabel, "新需求");
  assert.equal(item.contact, "wx-test");
  assert.equal(item.contactType, "wechat");
  assert.equal(item.contactTypeLabel, "微信号");
  assert.equal(item.contactCopyLabel, "复制微信号");
  assert.equal(item.content, "想做一套包装");
  assert.deepEqual(plain(item.packageTypes), ["礼盒", "整套包装"]);
});

test("maps inquiry admin status labels", () => {
  assert.equal(getInquiryStatusLabel("new"), "新需求");
  assert.equal(getInquiryStatusLabel("contacted"), "已联系");
  assert.equal(getInquiryStatusLabel("processing"), "跟进中");
  assert.equal(getInquiryStatusLabel("done"), "已完成");
  assert.equal(getInquiryStatusLabel("invalid"), "无效需求");
  assert.equal(getInquiryStatusLabel("unknown"), "新需求");
});

test("normalizes inquiry admin keyword", () => {
  assert.equal(normalizeInquiryKeyword("  case_001  "), "case_001");
  assert.equal(normalizeInquiryKeyword(null), "");
});

test("keeps legacy and invalid inquiry contact types safe", () => {
  assert.equal(getContactTypeLabel("phone"), "手机号");
  assert.equal(getContactTypeLabel("email"), "邮箱");
  assert.equal(getContactTypeLabel("legacy"), "类型未标注");
  assert.equal(getContactCopyLabel("legacy"), "复制联系方式");
});

test("validates admin note length", () => {
  assert.equal(normalizeAdminNote("  已联系客户  "), "已联系客户");
  assert.equal(validateAdminNote("a".repeat(ADMIN_NOTE_MAX_LENGTH)).valid, true);
  assert.equal(validateAdminNote("a".repeat(ADMIN_NOTE_MAX_LENGTH + 1)).message, "管理员备注最多 500 个字");
});

test("normalizes incomplete inquiry records safely", () => {
  const item = normalizeInquiryAdminItem(null);

  assert.equal(item.id, "");
  assert.equal(item.status, "new");
  assert.equal(item.contact, "");
  assert.equal(item.contactType, "");
  assert.equal(item.contactTypeLabel, "类型未标注");
  assert.deepEqual(plain(item.packageTypes), []);
  assert.deepEqual(plain(item.styles), []);
  assert.deepEqual(plain(item.scenes), []);
});
