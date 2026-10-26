const STATUS_LABELS = Object.freeze({
  new: "已提交",
  contacted: "已回复",
  processing: "跟进中",
  done: "已完成",
  invalid: "已关闭",
});

const CONTACT_TYPE_LABELS = Object.freeze({
  wechat: "微信号",
  phone: "手机号",
  email: "邮箱",
});

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanList(value) {
  return Array.isArray(value) ? value.map(trimText).filter(Boolean) : [];
}

function toDate(value) {
  if (!value) return null;
  if (value && typeof value === "object" && value.$date) return toDate(value.$date);
  if (value && typeof value.toDate === "function") return value.toDate();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateTime(value) {
  const date = toDate(value);
  if (!date) return "";
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function truncate(value, maxLength = 52) {
  const text = trimText(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function normalizeMyInquiry(item = {}) {
  const status = STATUS_LABELS[item.status] ? item.status : "new";
  const packageTypes = cleanList(item.packageTypes);
  const styles = cleanList(item.styles);
  const scenes = cleanList(item.scenes);
  const unreadCount = Math.max(0, Number(item.customerUnreadCount) || 0);
  return {
    id: trimText(item.id || item._id),
    source: trimText(item.source),
    caseDocId: trimText(item.caseDocId),
    caseId: trimText(item.caseId),
    caseTitle: trimText(item.caseTitle),
    wineType: trimText(item.wineType),
    packageTypes,
    packageSummary: packageTypes.join(" / "),
    styles,
    styleSummary: styles.join(" / "),
    priceLevel: trimText(item.priceLevel),
    scenes,
    sceneSummary: scenes.join(" / "),
    content: trimText(item.content),
    contentPreview: truncate(item.content),
    contact: trimText(item.contact),
    contactType: CONTACT_TYPE_LABELS[item.contactType] ? item.contactType : "",
    contactTypeLabel: CONTACT_TYPE_LABELS[item.contactType] || "联系方式",
    status,
    statusLabel: STATUS_LABELS[status],
    createdAt: item.createdAt || "",
    createdAtText: formatDateTime(item.createdAt),
    lastAdminReplyAt: item.lastAdminReplyAt || "",
    lastAdminReplyAtText: formatDateTime(item.lastAdminReplyAt),
    lastAdminReplyPreview: truncate(item.lastAdminReplyPreview, 70),
    customerUnreadCount: unreadCount,
    unreadLabel: unreadCount > 99 ? "99+" : String(unreadCount),
  };
}

function normalizeInquiryMessage(item = {}) {
  return {
    id: trimText(item.id || item._id),
    inquiryId: trimText(item.inquiryId),
    content: trimText(item.content),
    createdAt: item.createdAt || "",
    createdAtText: formatDateTime(item.createdAt),
    readAt: item.readAt || "",
  };
}

module.exports = {
  CONTACT_TYPE_LABELS,
  STATUS_LABELS,
  formatDateTime,
  normalizeInquiryMessage,
  normalizeMyInquiry,
};
