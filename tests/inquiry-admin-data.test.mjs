import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadCommonJsModule(modulePath, dependencies = {}) {
  const source = readFileSync(modulePath, "utf8");
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require(moduleName) {
      if (dependencies[moduleName]) return dependencies[moduleName];
      throw new Error(`Unexpected require: ${moduleName}`);
    },
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(source, sandbox, { filename: modulePath });
  return sandbox.module.exports;
}

const inquiryAdminDataPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/inquiry-admin/utils/inquiryAdminData.js"
);
const caseDataPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/utils/caseData.js"
);
const caseData = loadCommonJsModule(caseDataPath);
const inquiryAdminData = loadCommonJsModule(inquiryAdminDataPath, {
  "../../../utils/caseData": caseData,
});

const {
  ADMIN_NOTE_MAX_LENGTH,
  DEFAULT_INQUIRY_STATUS,
  REPLY_MAX_LENGTH,
  buildInquiryTimeline,
  countCharacters,
  getInquiryStatusLabel,
  getContactCopyLabel,
  getContactTypeLabel,
  normalizeAdminNote,
  normalizeInquiryAdminItem,
  normalizeInquiryKeyword,
  normalizeInquiryMessage,
  normalizeInquirySummary,
  validateAdminNote,
  validateReplyContent,
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

test("shows the wedding scene alias without changing the stored inquiry value", () => {
  const item = normalizeInquiryAdminItem({ scenes: ["婚宴", "生日宴"] });

  assert.deepEqual(plain(item.scenes), ["婚宴", "生日宴"]);
  assert.equal(item.sceneSummary, "婚宴/喜宴 / 生日宴");
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

test("normalizes new and legacy claim and reply fields", () => {
  const legacy = normalizeInquiryAdminItem({
    _id: "legacy_1",
    claimedByOpenid: "admin_a",
    claimedAt: "2026-08-21T01:01:00.000Z",
    lastAdminReplyPreview: "已经添加您微信好友",
    lastAdminReplyAt: "2026-08-21T01:02:00.000Z",
  }, { currentOpenid: "admin_a" });
  assert.equal(legacy.claim.isMine, true);
  assert.equal(legacy.claimState, "mine");
  assert.equal(legacy.lastReply.content, "已经添加您微信好友");

  const current = normalizeInquiryAdminItem({
    claim: { claimedBy: "admin_b", claimedAt: "2026-08-21T02:00:00.000Z" },
    lastReply: { content: "需求已收到", createdAt: "2026-08-21T02:01:00.000Z" },
  }, { currentOpenid: "admin_a" });
  assert.equal(current.claimState, "claimed");
  assert.equal(current.claimLabel, "已被管理员认领");
  assert.equal(current.lastReply.content, "需求已收到");
});

test("marks inferred legacy contact types for explicit confirmation", () => {
  const inferred = normalizeInquiryAdminItem({
    contact: "13800138000",
    contactType: "phone",
    contactTypeSource: "inferred_legacy",
  });
  assert.equal(inferred.contactTypeLabel, "手机号");
  assert.equal(inferred.contactTypeNeedsConfirmation, true);
  assert.equal(inferred.contactTypeSourceLabel, "旧数据推断待确认");

  const corrected = normalizeInquiryAdminItem({
    contact: "13800138000",
    contactType: "phone",
    contactTypeSource: "admin_corrected",
  });
  assert.equal(corrected.contactTypeNeedsCorrection, false);
  assert.equal(corrected.contactTypeSourceLabel, "管理员已确认");
});

test("shows the inquiry-level notifier failure on the admin list card", () => {
  const failed = normalizeInquiryAdminItem({
    _id: "inquiry_failed_email",
    emailNotificationStatus: "permanent_failed",
    emailNotificationUpdatedAt: "2026-08-21T03:00:00.000Z",
  });
  assert.equal(failed.notificationFailed, true);
  assert.equal(failed.notificationLabel, "邮件通知异常");
  assert.equal(failed.alertSummary.status, "permanent_failed");

  const sent = normalizeInquiryAdminItem({
    _id: "inquiry_sent_email",
    emailNotificationStatus: "sent",
  });
  assert.equal(sent.notificationFailed, false);
  assert.equal(sent.notificationLabel, "");
});

test("validates customer-visible replies with unicode character limits", () => {
  assert.equal(validateReplyContent("   ").valid, false);
  assert.equal(validateReplyContent("已收到需求").replyContent, "已收到需求");
  assert.equal(countCharacters("🍷"), 1);
  assert.equal(validateReplyContent("🍷".repeat(REPLY_MAX_LENGTH)).valid, true);
  assert.equal(validateReplyContent("🍷".repeat(REPLY_MAX_LENGTH + 1)).valid, false);
});

test("normalizes summary health without exposing notifier error details", () => {
  const healthy = normalizeInquirySummary({
    total: 9,
    byStatus: { new: 4, processing: 2 },
    unclaimedCount: 3,
    mineCount: 2,
    followupEnabled: true,
    emailAlertsEnabled: true,
    emailNotifierStatus: "ready",
  });
  assert.equal(healthy.newCount, 4);
  assert.equal(healthy.processingCount, 2);
  assert.equal(healthy.emailAlertHasIssue, false);

  const unhealthy = normalizeInquirySummary({
    followupEnabled: true,
    emailAlertsEnabled: true,
    emailNotifierStatus: "disabled",
    emailNotifierReason: "raw smtp secret should not surface",
  });
  assert.equal(unhealthy.emailAlertHasIssue, true);
  assert.equal(Object.prototype.hasOwnProperty.call(unhealthy, "emailNotifierReason"), false);

  const intentionallyDisabled = normalizeInquirySummary({
    followupEnabled: true,
    emailAlertsEnabled: false,
    emailNotifierStatus: "disabled",
  });
  assert.equal(intentionallyDisabled.emailAlertHasIssue, false);
});

test("builds an ascending admin timeline from submission, claim, and replies", () => {
  const item = normalizeInquiryAdminItem({
    _id: "inq_timeline",
    createdAt: "2026-08-21T01:00:00.000Z",
    claimedBy: "admin_a",
    claimedAt: "2026-08-21T01:05:00.000Z",
  }, { currentOpenid: "admin_a" });
  const message = normalizeInquiryMessage({
    _id: "message_1",
    content: "已添加微信",
    createdAt: "2026-08-21T01:10:00.000Z",
  });
  const timeline = buildInquiryTimeline(item, [message]);
  assert.deepEqual(plain(timeline.map((event) => event.type)), ["submitted", "claimed", "reply"]);
  assert.equal(timeline[2].content, "已添加微信");
});
