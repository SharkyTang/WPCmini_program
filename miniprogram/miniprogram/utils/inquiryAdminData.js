const DEFAULT_INQUIRY_STATUS = "new";
const ADMIN_NOTE_MAX_LENGTH = 500;

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

const SOURCE_LABELS = {
  profile: "个人中心",
  detail: "案例详情",
};

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => trimText(item))
    .filter(Boolean);
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

function validateAdminNote(note) {
  const adminNote = normalizeAdminNote(note);
  if (adminNote.length > ADMIN_NOTE_MAX_LENGTH) {
    return {
      valid: false,
      message: `管理员备注最多 ${ADMIN_NOTE_MAX_LENGTH} 个字`,
    };
  }
  return {
    valid: true,
    adminNote,
  };
}

function formatDateTime(value) {
  if (!value) return "";

  let date = value;
  if (typeof value === "object" && value.$date) {
    date = value.$date;
  }
  if (typeof value === "object" && typeof value.toDate === "function") {
    date = value.toDate();
  }

  const parsedDate = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(parsedDate.getTime())) {
    return trimText(String(value));
  }

  const pad = (number) => String(number).padStart(2, "0");
  const year = parsedDate.getFullYear();
  const month = pad(parsedDate.getMonth() + 1);
  const day = pad(parsedDate.getDate());
  const hour = pad(parsedDate.getHours());
  const minute = pad(parsedDate.getMinutes());
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function buildSummary(values) {
  return values.slice(0, 3).join(" / ");
}

function truncateText(value, maxLength = 56) {
  const text = trimText(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function normalizeInquiryAdminItem(item) {
  const source = item || {};
  const status = normalizeInquiryStatus(source.status);
  const packageTypes = normalizeStringList(source.packageTypes);
  const styles = normalizeStringList(source.styles);
  const scenes = normalizeStringList(source.scenes);
  const content = trimText(source.content);

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
    sceneSummary: buildSummary(scenes),
    content,
    contentPreview: truncateText(content),
    contact: trimText(source.contact),
    openid: trimText(source.openid),
    status,
    statusLabel: getInquiryStatusLabel(status),
    adminNote: normalizeAdminNote(source.adminNote),
    createdAt: source.createdAt || "",
    createdAtText: formatDateTime(source.createdAt),
    updatedAt: source.updatedAt || "",
    updatedAtText: formatDateTime(source.updatedAt),
    updatedByOpenid: trimText(source.updatedByOpenid),
  };
}

module.exports = {
  ADMIN_NOTE_MAX_LENGTH,
  DEFAULT_INQUIRY_STATUS,
  INQUIRY_FILTER_OPTIONS,
  INQUIRY_STATUS_OPTIONS,
  INQUIRY_STATUS_LABELS,
  formatDateTime,
  getInquiryStatusLabel,
  normalizeAdminNote,
  normalizeInquiryAdminItem,
  normalizeInquiryKeyword,
  normalizeInquiryStatus,
  validateAdminNote,
};
