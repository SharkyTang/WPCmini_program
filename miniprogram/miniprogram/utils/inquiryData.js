const { DEFAULT_FILTERS, normalizeValues } = require("./caseData");

const INQUIRY_COLLECTION = "inquiries";
const CONTENT_MIN_LENGTH = 5;
const CONTENT_MAX_LENGTH = 800;
const CONTACT_MAX_LENGTH = 120;

const INQUIRY_OPTION_KEYS = ["wineType", "packageTypes", "styles", "priceLevel", "scenes"];

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanArray(value) {
  return normalizeValues(value)
    .map((item) => trimText(item))
    .filter(Boolean);
}

function firstText(value) {
  if (Array.isArray(value)) return trimText(value[0]);
  if (value && Array.isArray(value.values)) return trimText(value.values[0]);
  return trimText(value);
}

function getInquiryOptionGroups() {
  return DEFAULT_FILTERS
    .filter((filter) => INQUIRY_OPTION_KEYS.includes(filter.key))
    .map((filter) => ({
      key: filter.key,
      title: filter.title,
      type: filter.type,
      options: filter.options.slice(),
    }));
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
    return {
      valid: false,
      message: "请选择包装内容",
    };
  }

  if (normalized.content.length < CONTENT_MIN_LENGTH) {
    return {
      valid: false,
      message: "请至少填写 5 个字",
    };
  }

  if (normalized.content.length > CONTENT_MAX_LENGTH) {
    return {
      valid: false,
      message: "补充说明最多 800 个字",
    };
  }

  if (!normalized.contact) {
    return {
      valid: false,
      message: "请填写联系方式",
    };
  }

  if (normalized.contact.length > CONTACT_MAX_LENGTH) {
    return {
      valid: false,
      message: "联系方式最多 120 个字",
    };
  }

  return {
    valid: true,
    message: "",
    data: normalized,
  };
}

function buildInquiryDraftFromCase(caseItem = {}) {
  return normalizeInquiryDraft({
    source: "detail",
    caseDocId: caseItem.id || caseItem._id,
    caseId: caseItem.caseId,
    caseTitle: caseItem.title,
    wineType: caseItem.wineType,
    packageTypes: caseItem.packageTypes,
    styles: caseItem.styles,
    priceLevel: caseItem.priceLevel,
    scenes: caseItem.scenes,
    content: "",
    contact: "",
  });
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
    systemInfo: context.systemInfo && typeof context.systemInfo === "object"
      ? context.systemInfo
      : {},
    status: "new",
  };
}

module.exports = {
  INQUIRY_COLLECTION,
  CONTENT_MIN_LENGTH,
  CONTENT_MAX_LENGTH,
  CONTACT_MAX_LENGTH,
  buildInquiryDraftFromCase,
  buildInquiryRecord,
  getInquiryOptionGroups,
  normalizeInquiryDraft,
  validateInquiryDraft,
};
