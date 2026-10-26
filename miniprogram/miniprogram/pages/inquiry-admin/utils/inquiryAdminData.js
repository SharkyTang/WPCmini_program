const { getSceneLabels } = require("../../../utils/caseData");

const DEFAULT_INQUIRY_STATUS = "new";
const ADMIN_NOTE_MAX_LENGTH = 500;
const REPLY_MAX_LENGTH = 300;

const INQUIRY_STATUS_LABELS = {
  new: "新需求",
  contacted: "已联系",
  processing: "跟进中",
  done: "已完成",
  invalid: "无效需求",
};

const INQUIRY_STATUS_OPTIONS = [
  { value: "new", label: "新需求" },
  { value: "contacted", label: "已联系" },
  { value: "processing", label: "跟进中" },
  { value: "done", label: "已完成" },
  { value: "invalid", label: "无效需求" },
];

const INQUIRY_FILTER_OPTIONS = [
  { value: "all", label: "全部" },
  ...INQUIRY_STATUS_OPTIONS,
];

const INQUIRY_CLAIM_FILTER_OPTIONS = [
  { value: "all", label: "全部负责人" },
  { value: "unclaimed", label: "未认领" },
  { value: "mine", label: "我跟进" },
];

const SOURCE_LABELS = {
  profile: "个人中心",
  detail: "案例详情",
};

const CONTACT_TYPE_LABELS = {
  wechat: "微信号",
  phone: "手机号",
  email: "邮箱",
};

const CONTACT_TYPE_OPTIONS = [
  { value: "wechat", label: "微信号" },
  { value: "phone", label: "手机号" },
  { value: "email", label: "邮箱" },
];

const QUICK_REPLY_OPTIONS = [
  {
    id: "wechat_added",
    label: "已加微信",
    content: "已经添加您微信好友了，麻烦您留意一下好友申请。",
  },
  {
    id: "received",
    label: "已收到需求",
    content: "已收到您的定制需求，我们正在整理方案，会尽快与您联系。",
  },
  {
    id: "following",
    label: "跟进中",
    content: "您好，我们已经开始跟进您的需求，如需补充信息，我们会通过您留下的联系方式与您确认。",
  },
];

const NOTIFICATION_FAILURE_STATUSES = new Set([
  "failed",
  "permanent_failed",
  "delivery_unknown",
  "error",
]);

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => trimText(item)).filter(Boolean);
}

function normalizeInquiryStatus(status) {
  return INQUIRY_STATUS_LABELS[status] ? status : DEFAULT_INQUIRY_STATUS;
}

function getInquiryStatusLabel(status) {
  return INQUIRY_STATUS_LABELS[normalizeInquiryStatus(status)];
}

function normalizeInquiryKeyword(keyword) {
  return trimText(keyword);
}

function normalizeAdminNote(note) {
  return trimText(note);
}

function normalizeContactType(value) {
  const contactType = trimText(value).toLowerCase();
  return CONTACT_TYPE_LABELS[contactType] ? contactType : "";
}

function getContactTypeLabel(value) {
  return CONTACT_TYPE_LABELS[normalizeContactType(value)] || "类型未标注";
}

function getContactCopyLabel(value) {
  const label = CONTACT_TYPE_LABELS[normalizeContactType(value)];
  return label ? `复制${label}` : "复制联系方式";
}

function countCharacters(value) {
  return Array.from(typeof value === "string" ? value : "").length;
}

function normalizeReplyContent(content) {
  return trimText(content).replace(/\r\n?/g, "\n");
}

function validateReplyContent(content) {
  const replyContent = normalizeReplyContent(content);
  if (!replyContent) {
    return { valid: false, message: "请填写要发送给客户的回复" };
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(replyContent)) {
    return { valid: false, message: "回复中含有无效字符" };
  }
  if (countCharacters(replyContent) > REPLY_MAX_LENGTH) {
    return { valid: false, message: `回复最多 ${REPLY_MAX_LENGTH} 个字` };
  }
  return { valid: true, replyContent };
}

function validateAdminNote(note) {
  const adminNote = normalizeAdminNote(note);
  if (adminNote.length > ADMIN_NOTE_MAX_LENGTH) {
    return {
      valid: false,
      message: `管理员备注最多 ${ADMIN_NOTE_MAX_LENGTH} 个字`,
    };
  }
  return { valid: true, adminNote };
}

function unwrapDate(value) {
  if (!value) return value;
  if (typeof value === "object" && value.$date) return value.$date;
  if (typeof value === "object" && typeof value.toDate === "function") {
    return value.toDate();
  }
  return value;
}

function toTimestamp(value) {
  const unwrapped = unwrapDate(value);
  const parsedDate = unwrapped instanceof Date ? unwrapped : new Date(unwrapped || 0);
  const timestamp = parsedDate.getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function formatDateTime(value) {
  if (!value) return "";
  const date = unwrapDate(value);
  const parsedDate = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(parsedDate.getTime())) return trimText(String(value));
  const pad = (number) => String(number).padStart(2, "0");
  return `${parsedDate.getFullYear()}-${pad(parsedDate.getMonth() + 1)}-${pad(parsedDate.getDate())} ${pad(parsedDate.getHours())}:${pad(parsedDate.getMinutes())}`;
}

function buildSummary(values) {
  return values.slice(0, 3).join(" / ");
}

function truncateText(value, maxLength = 56) {
  const text = trimText(value);
  if (countCharacters(text) <= maxLength) return text;
  return `${Array.from(text).slice(0, maxLength).join("")}...`;
}

function normalizeClaim(item = {}, options = {}) {
  const nestedClaim = item.claim && typeof item.claim === "object" ? item.claim : {};
  const claimedBy = trimText(
    nestedClaim.claimedBy
      || nestedClaim.claimedByOpenid
      || item.claimedBy
      || item.claimedByOpenid
  );
  const claimedAt = nestedClaim.claimedAt || item.claimedAt || "";
  const currentOpenid = trimText(options.currentOpenid);
  const explicitMine = nestedClaim.isMine === true
    || item.claimIsMine === true
    || item.isClaimedByMe === true;
  const isMine = Boolean(
    claimedBy && (explicitMine || (currentOpenid && claimedBy === currentOpenid))
  );
  const state = !claimedBy ? "unclaimed" : isMine ? "mine" : "claimed";
  return {
    claimedBy,
    claimedAt,
    claimedAtText: formatDateTime(claimedAt),
    isClaimed: Boolean(claimedBy),
    isMine,
    state,
    label: state === "unclaimed"
      ? "未认领"
      : state === "mine"
        ? "我在跟进"
        : "已被管理员认领",
  };
}

function normalizeLastReply(item = {}) {
  const nestedReply = item.lastReply && typeof item.lastReply === "object"
    ? item.lastReply
    : {};
  const content = trimText(
    nestedReply.content || item.lastReplyPreview || item.lastAdminReplyPreview
  );
  const createdAt = nestedReply.createdAt || item.repliedAt || item.lastAdminReplyAt || "";
  const createdByOpenid = trimText(
    nestedReply.createdByOpenid || item.lastRepliedBy || item.lastAdminRepliedBy
  );
  if (!content && !createdAt) return null;
  return {
    content,
    contentPreview: truncateText(content, 80),
    createdAt,
    createdAtText: formatDateTime(createdAt),
    createdByOpenid,
  };
}

function normalizeAlertSummary(item = {}) {
  const nested = item.alertSummary && typeof item.alertSummary === "object"
    ? item.alertSummary
    : item.notificationSummary && typeof item.notificationSummary === "object"
      ? item.notificationSummary
      : {};
  const status = trimText(
    nested.status
      || item.emailNotificationStatus
      || item.adminNotificationStatus
      || item.notificationStatus
      || item.alertStatus
      || item.alertState
  ).toLowerCase();
  const failed = nested.failed === true
    || item.notificationFailed === true
    || NOTIFICATION_FAILURE_STATUSES.has(status);
  return { status, failed, label: failed ? "邮件通知异常" : "" };
}

function normalizeContactTypeSource(value, contactType, contact) {
  const source = trimText(value).toLowerCase();
  const needsConfirmation = source === "inferred_legacy";
  const missing = Boolean(contact && !contactType);
  let label = "";
  if (source === "customer_selected") label = "客户已选择";
  if (source === "admin_corrected") label = "管理员已确认";
  if (source === "inferred_legacy") label = "旧数据推断待确认";
  if (source === "legacy_missing" || missing) label = "旧数据未标注";
  return {
    source,
    label,
    needsConfirmation,
    needsCorrection: needsConfirmation || missing,
  };
}

function normalizeInquiryMessage(message = {}) {
  const createdAt = message.createdAt || "";
  return {
    id: trimText(message._id || message.id),
    inquiryId: trimText(message.inquiryId),
    direction: trimText(message.direction) || "admin_to_customer",
    content: trimText(message.content),
    createdAt,
    createdAtText: formatDateTime(createdAt),
    createdByOpenid: trimText(message.createdByOpenid),
  };
}

function buildInquiryTimeline(item = {}, messages = []) {
  const timeline = [];
  if (item.createdAt) {
    timeline.push({
      id: `submitted_${item.id || "inquiry"}`,
      type: "submitted",
      title: "客户提交定制需求",
      content: "需求已进入管理员跟进列表",
      createdAt: item.createdAt,
      createdAtText: formatDateTime(item.createdAt),
    });
  }
  const claim = item.claim || normalizeClaim(item);
  if (claim && claim.isClaimed && claim.claimedAt) {
    timeline.push({
      id: `claimed_${item.id || "inquiry"}`,
      type: "claimed",
      title: claim.isMine ? "我已认领需求" : "管理员已认领需求",
      content: "需求已进入跟进流程",
      createdAt: claim.claimedAt,
      createdAtText: formatDateTime(claim.claimedAt),
    });
  }
  (messages || []).map(normalizeInquiryMessage).forEach((message, index) => {
    if (!message.content && !message.createdAt) return;
    timeline.push({
      id: message.id || `reply_${index}`,
      type: "reply",
      title: "管理员回复客户",
      content: message.content,
      createdAt: message.createdAt,
      createdAtText: message.createdAtText,
    });
  });
  return timeline.sort((left, right) => toTimestamp(left.createdAt) - toTimestamp(right.createdAt));
}

function normalizeInquirySummary(summary = {}) {
  const numberOrZero = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
  };
  const byStatus = summary.byStatus && typeof summary.byStatus === "object"
    ? summary.byStatus
    : {};
  const emailNotifierStatus = trimText(summary.emailNotifierStatus).toLowerCase();
  const followupEnabled = summary.followupEnabled === true;
  const emailAlertsEnabled = followupEnabled && summary.emailAlertsEnabled === true;
  const emailAlertIssueCount = numberOrZero(summary.emailAlertIssueCount);
  return {
    total: numberOrZero(summary.total),
    newCount: numberOrZero(summary.newCount !== undefined ? summary.newCount : byStatus.new),
    contactedCount: numberOrZero(
      summary.contactedCount !== undefined ? summary.contactedCount : byStatus.contacted
    ),
    processingCount: numberOrZero(
      summary.processingCount !== undefined ? summary.processingCount : byStatus.processing
    ),
    doneCount: numberOrZero(summary.doneCount !== undefined ? summary.doneCount : byStatus.done),
    invalidCount: numberOrZero(
      summary.invalidCount !== undefined ? summary.invalidCount : byStatus.invalid
    ),
    unclaimedCount: summary.unclaimedCount === null || summary.unclaimedCount === undefined
      ? null
      : numberOrZero(summary.unclaimedCount),
    mineCount: numberOrZero(summary.mineCount),
    followupEnabled,
    emailAlertsEnabled,
    customerPushEnabled: summary.customerPushEnabled === true,
    emailNotifierStatus,
    emailAlertIssueCount,
    emailAlertHasIssue: emailAlertIssueCount > 0
      || Boolean(
        emailAlertsEnabled
        && emailNotifierStatus
        && emailNotifierStatus !== "ready"
      ),
  };
}

function normalizeInquiryAdminItem(item, options = {}) {
  const source = item || {};
  const status = normalizeInquiryStatus(source.status);
  const packageTypes = normalizeStringList(source.packageTypes);
  const styles = normalizeStringList(source.styles);
  const scenes = normalizeStringList(source.scenes);
  const content = trimText(source.content);
  const contactType = normalizeContactType(source.contactType);
  const contact = trimText(source.contact);
  const claim = normalizeClaim(source, options);
  const lastReply = normalizeLastReply(source);
  const alertSummary = normalizeAlertSummary(source);
  const contactTypeMeta = normalizeContactTypeSource(
    source.contactTypeSource,
    contactType,
    contact
  );

  return {
    id: trimText(source._id || source.id),
    source: trimText(source.source),
    sourceLabel: SOURCE_LABELS[source.source] || "未知来源",
    caseDocId: trimText(source.caseDocId),
    caseId: trimText(source.caseId),
    caseTitle: trimText(source.caseTitle),
    wineType: trimText(source.wineType),
    packageTypes,
    packageSummary: buildSummary(packageTypes),
    styles,
    styleSummary: buildSummary(styles),
    priceLevel: trimText(source.priceLevel),
    scenes,
    sceneSummary: buildSummary(getSceneLabels(scenes)),
    content,
    contentPreview: truncateText(content),
    contact,
    contactType,
    contactTypeLabel: getContactTypeLabel(contactType),
    contactCopyLabel: getContactCopyLabel(contactType),
    contactTypeSource: contactTypeMeta.source,
    contactTypeSourceLabel: contactTypeMeta.label,
    contactTypeNeedsConfirmation: contactTypeMeta.needsConfirmation,
    contactTypeNeedsCorrection: contactTypeMeta.needsCorrection,
    openid: trimText(source.openid),
    status,
    statusLabel: getInquiryStatusLabel(status),
    adminNote: normalizeAdminNote(source.adminNote),
    claim,
    claimState: claim.state,
    claimLabel: claim.label,
    lastReply,
    alertSummary,
    notificationFailed: alertSummary.failed,
    notificationLabel: alertSummary.label,
    isNewUnclaimed: status === "new" && !claim.isClaimed,
    replyCount: Math.max(0, Number(source.replyCount) || 0),
    createdAt: source.createdAt || "",
    createdAtText: formatDateTime(source.createdAt),
    updatedAt: source.updatedAt || "",
    updatedAtText: formatDateTime(source.updatedAt),
    updatedByOpenid: trimText(source.updatedByOpenid),
  };
}

module.exports = {
  ADMIN_NOTE_MAX_LENGTH,
  CONTACT_TYPE_LABELS,
  CONTACT_TYPE_OPTIONS,
  DEFAULT_INQUIRY_STATUS,
  INQUIRY_CLAIM_FILTER_OPTIONS,
  INQUIRY_FILTER_OPTIONS,
  INQUIRY_STATUS_OPTIONS,
  INQUIRY_STATUS_LABELS,
  QUICK_REPLY_OPTIONS,
  REPLY_MAX_LENGTH,
  buildInquiryTimeline,
  countCharacters,
  formatDateTime,
  getContactCopyLabel,
  getContactTypeLabel,
  getInquiryStatusLabel,
  normalizeAdminNote,
  normalizeAlertSummary,
  normalizeClaim,
  normalizeContactType,
  normalizeInquiryAdminItem,
  normalizeInquiryKeyword,
  normalizeInquiryMessage,
  normalizeInquiryStatus,
  normalizeInquirySummary,
  normalizeReplyContent,
  validateAdminNote,
  validateReplyContent,
};
