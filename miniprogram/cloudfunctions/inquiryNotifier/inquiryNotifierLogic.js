const crypto = require("crypto");

const PLAN_VERSION = "email-v1";
const JOB_ID_LENGTH = 32;
const RETRY_DELAYS_MS = Object.freeze([
  30 * 1000,
  2 * 60 * 1000,
  5 * 60 * 1000,
]);
const STAGE_DEFINITIONS = Object.freeze([
  Object.freeze({
    key: "primary_immediate",
    recipientRole: "primary",
    delayMs: 0,
    label: "主负责人首次提醒",
  }),
  Object.freeze({
    key: "primary_2_immediate",
    recipientRole: "primary_2",
    delayMs: 0,
    label: "第二主负责人首次提醒",
  }),
  Object.freeze({
    key: "backup_5m",
    recipientRole: "backup",
    delayMs: 5 * 60 * 1000,
    label: "备用负责人提醒",
  }),
  Object.freeze({
    key: "primary_15m",
    recipientRole: "primary",
    delayMs: 15 * 60 * 1000,
    label: "主负责人再次提醒",
  }),
  Object.freeze({
    key: "primary_2_15m",
    recipientRole: "primary_2",
    delayMs: 15 * 60 * 1000,
    label: "第二主负责人再次提醒",
  }),
  Object.freeze({
    key: "backup_15m",
    recipientRole: "backup",
    delayMs: 15 * 60 * 1000,
    label: "备用负责人再次提醒",
  }),
]);

const PERMANENT_ERROR_CODES = new Set([
  "EAUTH",
  "EENVELOPE",
  "EMESSAGE",
  "INVALID_RECIPIENT",
  "MAIL_DISABLED",
  "SMTP_NOT_CONFIGURED",
]);
const TRANSIENT_ERROR_CODES = new Set([
  "ECONNECTION",
  "ECONNREFUSED",
  "ECONNRESET",
  "EDNS",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ESOCKET",
]);
const TIMEOUT_ERROR_CODES = new Set([
  "ETIMEOUT",
  "ETIMEDOUT",
]);
const INQUIRY_SOURCE_LABELS = Object.freeze({
  profile: "个人中心",
  detail: "案例详情",
});
const INQUIRY_EMAIL_TERMINAL_STATUSES = Object.freeze([
  "sent",
  "failed",
  "permanent_failed",
  "delivery_unknown",
  "cancelled",
]);
const INQUIRY_EMAIL_FAILURE_STATUSES = new Set([
  "failed",
  "permanent_failed",
  "delivery_unknown",
]);

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isValidInternalToken(expectedValue, providedValue) {
  if (typeof expectedValue !== "string" || typeof providedValue !== "string") {
    return false;
  }
  if (!expectedValue.length || !providedValue.length) return false;
  // Hash first so timingSafeEqual always compares equal-length buffers. This
  // keeps both value and length differences out of the comparison timing.
  const expectedDigest = crypto
    .createHash("sha256")
    .update(expectedValue, "utf8")
    .digest();
  const providedDigest = crypto
    .createHash("sha256")
    .update(providedValue, "utf8")
    .digest();
  return crypto.timingSafeEqual(expectedDigest, providedDigest);
}

function toTimestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (value && typeof value.toDate === "function") {
    return value.toDate().getTime();
  }
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function hashText(value, length = JOB_ID_LENGTH) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex")
    .slice(0, length);
}

function buildJobId(inquiryId, stageKey) {
  return hashText(`${PLAN_VERSION}\n${trimText(inquiryId)}\n${trimText(stageKey)}`);
}

function createLeaseOwner() {
  return crypto.randomBytes(12).toString("hex");
}

function buildStageJobs(inquiry = {}, now = Date.now()) {
  const inquiryId = trimText(inquiry._id || inquiry.id);
  if (!inquiryId) return [];
  const hasSubmittedAt = inquiry.createdAt !== null
    && inquiry.createdAt !== undefined
    && inquiry.createdAt !== "";
  const submittedAt = hasSubmittedAt
    ? toTimestamp(inquiry.createdAt)
    : Number(now);
  return STAGE_DEFINITIONS.map((stage) => ({
    _id: buildJobId(inquiryId, stage.key),
    planVersion: PLAN_VERSION,
    inquiryId,
    stageKey: stage.key,
    recipientRole: stage.recipientRole,
    submittedAt: new Date(submittedAt),
    inquirySource: Object.prototype.hasOwnProperty.call(
      INQUIRY_SOURCE_LABELS,
      trimText(inquiry.source)
    )
      ? trimText(inquiry.source)
      : "other",
    dueAt: new Date(submittedAt + stage.delayMs),
    status: "pending",
    attempt: 0,
  }));
}

function formatSubmittedAt(value) {
  const timestamp = toTimestamp(value);
  if (!timestamp) return "未记录";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute} 北京时间`;
}

function hasMarker(value) {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") return Boolean(value.trim());
  if (typeof value === "number") return value > 0;
  return true;
}

function getInquiryStopReason(inquiry) {
  if (!inquiry) return "inquiry_missing";
  if (
    hasMarker(inquiry.firstReplyAt)
    || hasMarker(inquiry.repliedAt)
    || hasMarker(inquiry.lastAdminReplyAt)
    || Number(inquiry.replyCount || 0) > 0
  ) {
    return "replied";
  }
  if (
    hasMarker(inquiry.claimedAt)
    || hasMarker(inquiry.claimedBy)
    || hasMarker(inquiry.claimedByOpenid)
  ) {
    return "claimed";
  }

  const status = trimText(inquiry.status).toLowerCase() || "new";
  if (status === "contacted" || status === "processing") return "claimed";
  if (status === "done" || status === "invalid") return "inquiry_closed";
  return "";
}

function getJobAction(job, now = Date.now()) {
  if (!job || !job._id) return "";
  const timestamp = Number(now);
  if (job.status === "pending") {
    const dueAt = toTimestamp(job.dueAt);
    return dueAt > 0 && dueAt <= timestamp ? "claim" : "";
  }
  if (job.status === "retry") {
    const retryAt = toTimestamp(job.nextAttemptAt);
    return retryAt > 0 && retryAt <= timestamp ? "claim" : "";
  }
  if (job.status === "processing") {
    return toTimestamp(job.leaseUntil) <= timestamp ? "recover_unknown" : "";
  }
  return "";
}

function normalizeInquiryEmailStatus(value) {
  const status = trimText(value).toLowerCase();
  return INQUIRY_EMAIL_TERMINAL_STATUSES.includes(status) ? status : "";
}

function resolveInquiryEmailStatus(currentValue, nextValue) {
  const current = normalizeInquiryEmailStatus(currentValue);
  const next = normalizeInquiryEmailStatus(nextValue);
  if (!next) return current;
  // A later successful or cancelled stage must never hide that any stage had
  // an operational delivery issue. Keep the first failure category visible so
  // the administrator card remains actionable.
  if (INQUIRY_EMAIL_FAILURE_STATUSES.has(current)) return current;
  if (INQUIRY_EMAIL_FAILURE_STATUSES.has(next)) return next;
  // Once at least one stage was accepted, a later cancellation simply means
  // escalation stopped; it does not turn the aggregate delivery into failure.
  if (current === "sent" && next === "cancelled") return current;
  return next;
}

function compareJobs(left, right) {
  const leftAt = left.status === "retry" ? left.nextAttemptAt : left.dueAt;
  const rightAt = right.status === "retry" ? right.nextAttemptAt : right.dueAt;
  const timeDifference = toTimestamp(leftAt) - toTimestamp(rightAt);
  if (timeDifference) return timeDifference;
  return trimText(left._id).localeCompare(trimText(right._id));
}

function getRetryDelayMs(completedAttemptCount) {
  const attempt = Number(completedAttemptCount);
  if (!Number.isInteger(attempt) || attempt < 1) return null;
  return RETRY_DELAYS_MS[attempt - 1] === undefined
    ? null
    : RETRY_DELAYS_MS[attempt - 1];
}

function normalizeErrorCode(value) {
  return trimText(value)
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "_")
    .slice(0, 48);
}

function classifyDeliveryError(error = {}) {
  const code = normalizeErrorCode(error.code || error.errCode);
  const responseCode = Number(error.responseCode || error.statusCode || 0);
  const message = trimText(error.message || error.errMsg);

  if (TIMEOUT_ERROR_CODES.has(code)) {
    return { category: "timeout", code };
  }
  if (/timed?\s*out|timeout/i.test(message)) {
    return { category: "timeout", code: "SMTP_TIMEOUT" };
  }
  if (responseCode >= 500 && responseCode <= 599) {
    return { category: "permanent", code: `SMTP_${responseCode}` };
  }
  if (responseCode >= 400 && responseCode <= 499) {
    return { category: "transient", code: `SMTP_${responseCode}` };
  }
  if (PERMANENT_ERROR_CODES.has(code)) {
    return { category: "permanent", code };
  }
  if (TRANSIENT_ERROR_CODES.has(code)) {
    return { category: "transient", code };
  }
  // Never persist an arbitrary provider-supplied code. Although SMTP error
  // codes are normally harmless, unexpected strings can contain account data.
  return { category: "transient", code: "SMTP_UNKNOWN" };
}

function isEnabledFlag(value) {
  return trimText(value).toLowerCase() === "true";
}

function isNotifierEnabled(env = {}) {
  const primaryFlag = trimText(env.INQUIRY_EMAIL_ALERTS_ENABLED);
  return isEnabledFlag(
    primaryFlag || env.INQUIRY_NOTIFIER_ENABLED
  );
}

function isEmailAddress(value) {
  const email = trimText(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getNotifierConfiguration(env = {}) {
  const enabled = isNotifierEnabled(env);
  if (!enabled) {
    return {
      enabled: false,
      ready: false,
      reason: "feature_disabled",
      recipients: {},
    };
  }

  const primary = trimText(env.INQUIRY_NOTIFY_PRIMARY_EMAIL);
  const primary2 = trimText(env.INQUIRY_NOTIFY_PRIMARY_EMAIL_2);
  const backup = trimText(env.INQUIRY_NOTIFY_BACKUP_EMAIL);
  const normalizedRecipients = [primary, primary2, backup]
    .map((recipient) => recipient.toLowerCase());
  const ready = [primary, primary2, backup].every(isEmailAddress)
    && new Set(normalizedRecipients).size === normalizedRecipients.length;

  return {
    enabled: true,
    ready,
    reason: ready ? "" : "recipient_not_configured",
    recipients: ready ? { primary, primary_2: primary2, backup } : {},
  };
}

function getStageDefinition(stageKey) {
  return STAGE_DEFINITIONS.find((stage) => stage.key === stageKey) || null;
}

function buildSafeMail(job = {}) {
  const stage = getStageDefinition(job.stageKey);
  const reference = hashText(`${PLAN_VERSION}\nmail\n${trimText(job._id)}`, 12);
  const inquiryReference = `REQ-${hashText(
    `${PLAN_VERSION}\ninquiry\n${trimText(job.inquiryId)}`,
    8
  ).toUpperCase()}`;
  const isReminder = Boolean(stage && stage.delayMs > 0);
  const subject = isReminder
    ? "【需求管理】定制需求仍待认领"
    : "【需求管理】有新的定制需求待处理";
  const stageLabel = stage ? stage.label : "管理员提醒";
  const sourceLabel = INQUIRY_SOURCE_LABELS[trimText(job.inquirySource)] || "其他入口";
  const text = [
    "需求管理中有一条定制需求待处理。",
    `需求编号：${inquiryReference}`,
    `提交时间：${formatSubmittedAt(job.submittedAt)}`,
    `来源：${sourceLabel}`,
    `提醒阶段：${stageLabel}`,
    `通知编号：${reference}`,
    "请登录小程序管理员端查看详情并认领。",
    "本邮件不包含客户联系方式或需求内容。",
    "认领或首次回复后，后续提醒会自动停止。",
  ].join("\n");
  return {
    subject,
    text,
    reference,
    messageId: `<${reference}@inquiry-notifier.local>`,
  };
}

module.exports = {
  INQUIRY_EMAIL_FAILURE_STATUSES,
  INQUIRY_EMAIL_TERMINAL_STATUSES,
  JOB_ID_LENGTH,
  PLAN_VERSION,
  RETRY_DELAYS_MS,
  STAGE_DEFINITIONS,
  buildJobId,
  buildSafeMail,
  buildStageJobs,
  classifyDeliveryError,
  compareJobs,
  createLeaseOwner,
  getInquiryStopReason,
  getJobAction,
  getNotifierConfiguration,
  getRetryDelayMs,
  formatSubmittedAt,
  hashText,
  isEmailAddress,
  isEnabledFlag,
  isValidInternalToken,
  isNotifierEnabled,
  normalizeInquiryEmailStatus,
  resolveInquiryEmailStatus,
  toTimestamp,
};
