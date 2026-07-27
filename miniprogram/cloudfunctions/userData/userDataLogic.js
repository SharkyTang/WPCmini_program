const INQUIRY_COLLECTION = "inquiries";
const FEEDBACK_COLLECTION = "feedback";
const CUSTOMER_NOTIFICATION_COLLECTION = "customer_notifications";
const NOTIFICATION_PREFERENCE_COLLECTION = "notification_preferences";

const INQUIRY_CONTENT_MIN_LENGTH = 5;
const INQUIRY_CONTENT_MAX_LENGTH = 800;
const INQUIRY_CONTACT_MAX_LENGTH = 120;
const FEEDBACK_CONTENT_MIN_LENGTH = 5;
const FEEDBACK_CONTENT_MAX_LENGTH = 800;
const FEEDBACK_CONTACT_MAX_LENGTH = 120;

const FEEDBACK_TYPE_LABELS = {
  bug: "遇到问题",
  suggestion: "体验建议",
  feature: "想要的功能",
  case_data: "图片或分类不对",
};

const NOTIFICATION_TYPE_KEYS = [
  "version_update",
  "product_new",
  "customer_reply",
];

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeValues(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (Array.isArray(value.values)) return value.values.filter(Boolean);
  if (typeof value === "string") return value ? [value] : [];
  return [];
}

function cleanArray(value) {
  return normalizeValues(value)
    .map(trimText)
    .filter(Boolean);
}

function firstText(value) {
  if (Array.isArray(value)) return trimText(value[0]);
  if (value && Array.isArray(value.values)) return trimText(value.values[0]);
  return trimText(value);
}

function normalizeSystemInfo(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return {
    brand: trimText(value.brand),
    model: trimText(value.model),
    platform: trimText(value.platform),
    system: trimText(value.system),
    version: trimText(value.version),
    SDKVersion: trimText(value.SDKVersion),
  };
}

function normalizeInquiryDraft(draft = {}) {
  return {
    source: trimText(draft.source),
    caseDocId: trimText(draft.caseDocId || draft.id || draft._id),
    caseId: trimText(draft.caseId),
    caseTitle: trimText(draft.caseTitle || draft.title),
    wineType: firstText(draft.wineType) || "白酒",
    packageTypes: cleanArray(draft.packageTypes),
    styles: cleanArray(draft.styles),
    priceLevel: firstText(draft.priceLevel),
    scenes: cleanArray(draft.scenes),
    content: trimText(draft.content),
    contact: trimText(draft.contact),
  };
}

function validateInquiryDraft(draft = {}) {
  const normalized = normalizeInquiryDraft(draft);

  if (!normalized.packageTypes.length) {
    return { valid: false, code: "INVALID_INQUIRY", message: "请选择包装内容" };
  }
  if (normalized.content.length < INQUIRY_CONTENT_MIN_LENGTH) {
    return { valid: false, code: "INVALID_INQUIRY", message: "请至少填写 5 个字" };
  }
  if (normalized.content.length > INQUIRY_CONTENT_MAX_LENGTH) {
    return { valid: false, code: "INVALID_INQUIRY", message: "补充说明最多 800 个字" };
  }
  if (!normalized.contact) {
    return { valid: false, code: "INVALID_INQUIRY", message: "请填写联系方式" };
  }
  if (normalized.contact.length > INQUIRY_CONTACT_MAX_LENGTH) {
    return { valid: false, code: "INVALID_INQUIRY", message: "联系方式最多 120 个字" };
  }

  return { valid: true, data: normalized };
}

function buildInquiryRecord(draft = {}, context = {}) {
  const normalized = normalizeInquiryDraft(draft);
  return {
    source: trimText(context.source || normalized.source) || "profile",
    caseDocId: normalized.caseDocId,
    caseId: normalized.caseId,
    caseTitle: normalized.caseTitle,
    wineType: normalized.wineType,
    packageTypes: normalized.packageTypes,
    styles: normalized.styles,
    priceLevel: normalized.priceLevel,
    scenes: normalized.scenes,
    content: normalized.content,
    contact: normalized.contact,
    sourcePage: trimText(context.sourcePage),
    route: trimText(context.route),
    openid: trimText(context.openid),
    appVersion: trimText(context.appVersion) || "v2.8",
    systemInfo: normalizeSystemInfo(context.systemInfo),
    status: "new",
  };
}

function normalizeFeedbackDraft(draft = {}) {
  const type = trimText(draft.type);
  return {
    type,
    typeLabel: FEEDBACK_TYPE_LABELS[type] || "",
    content: trimText(draft.content),
    contact: trimText(draft.contact),
  };
}

function validateFeedbackDraft(draft = {}) {
  const normalized = normalizeFeedbackDraft(draft);

  if (!normalized.type || !FEEDBACK_TYPE_LABELS[normalized.type]) {
    return { valid: false, code: "INVALID_FEEDBACK", message: "请选择反馈类型" };
  }
  if (normalized.content.length < FEEDBACK_CONTENT_MIN_LENGTH) {
    return { valid: false, code: "INVALID_FEEDBACK", message: "请至少填写 5 个字" };
  }
  if (normalized.content.length > FEEDBACK_CONTENT_MAX_LENGTH) {
    return { valid: false, code: "INVALID_FEEDBACK", message: "内容最多 800 个字" };
  }
  if (normalized.contact.length > FEEDBACK_CONTACT_MAX_LENGTH) {
    return { valid: false, code: "INVALID_FEEDBACK", message: "联系方式最多 120 个字" };
  }

  return { valid: true, data: normalized };
}

function buildFeedbackRecord(draft = {}, context = {}) {
  const normalized = normalizeFeedbackDraft(draft);
  return {
    type: normalized.type,
    typeLabel: normalized.typeLabel,
    content: normalized.content,
    contact: normalized.contact,
    sourcePage: trimText(context.sourcePage),
    route: trimText(context.route),
    openid: trimText(context.openid),
    appVersion: trimText(context.appVersion) || "v2.6",
    systemInfo: normalizeSystemInfo(context.systemInfo),
    status: "new",
  };
}

function normalizeDisabledTypes(disabledTypes = []) {
  return Array.from(
    new Set((disabledTypes || []).filter((type) => NOTIFICATION_TYPE_KEYS.includes(type)))
  );
}

function pickPreferenceRecord(records = []) {
  return (records || [])[0] || null;
}

module.exports = {
  CUSTOMER_NOTIFICATION_COLLECTION,
  FEEDBACK_COLLECTION,
  INQUIRY_COLLECTION,
  NOTIFICATION_PREFERENCE_COLLECTION,
  buildFeedbackRecord,
  buildInquiryRecord,
  normalizeDisabledTypes,
  pickPreferenceRecord,
  validateFeedbackDraft,
  validateInquiryDraft,
};
