const {
  DEFAULT_FILTERS,
  getSceneLabel,
  normalizeValues,
} = require("../../../utils/caseData");

const INQUIRY_COLLECTION = "inquiries";
const INQUIRY_SCHEMA_VERSION = 2;
const CONTENT_MIN_LENGTH = 5;
const CONTENT_MAX_LENGTH = 800;
const CONTACT_MAX_LENGTH = 120;
const CONTACT_TYPES = Object.freeze({
  WECHAT: "wechat",
  PHONE: "phone",
  EMAIL: "email",
});
const CONTACT_TYPE_VALUES = Object.freeze(Object.values(CONTACT_TYPES));

const INQUIRY_OPTION_KEYS = ["wineType", "packageTypes", "styles", "priceLevel", "scenes"];

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeContactType(value) {
  const contactType = trimText(value).toLowerCase();
  return CONTACT_TYPE_VALUES.includes(contactType) ? contactType : "";
}

function isValidPhone(value) {
  const phone = trimText(value).replace(/[\s-]/g, "");
  return /^(?:\+?86)?1[3-9]\d{9}$/.test(phone);
}

function isValidEmail(value) {
  const email = trimText(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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

function getInquiryOptionLabel(field, value) {
  return field === "scenes" ? getSceneLabel(value) : value;
}

function normalizeInquiryDraft(draft = {}) {
  const schemaVersion = Number(draft.inquirySchemaVersion);
  return {
    inquirySchemaVersion: Number.isInteger(schemaVersion) && schemaVersion > 0
      ? schemaVersion
      : INQUIRY_SCHEMA_VERSION,
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
    contactType: normalizeContactType(draft.contactType),
  };
}

function validateInquiryDraft(draft = {}) {
  const normalized = normalizeInquiryDraft(draft);
  const rawContactType = trimText(draft.contactType).toLowerCase();

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
      message: normalized.contactType === CONTACT_TYPES.PHONE
        ? "请输入手机号"
        : normalized.contactType === CONTACT_TYPES.EMAIL
          ? "请输入邮箱"
          : normalized.contactType === CONTACT_TYPES.WECHAT
            ? "请输入微信号"
            : "请填写联系方式",
    };
  }

  if (normalized.contact.length > CONTACT_MAX_LENGTH) {
    return {
      valid: false,
      message: "联系方式最多 120 个字",
    };
  }

  // 新版客户端必须带合法类型；旧版兼容只保留在云函数入口，避免新版
  // 页面把缺失类型的错误拖到提交后才反馈。
  if (rawContactType && !normalized.contactType) {
    return {
      valid: false,
      message: "联系方式类型无效",
    };
  }

  if (
    normalized.inquirySchemaVersion >= INQUIRY_SCHEMA_VERSION
    && !normalized.contactType
  ) {
    return {
      valid: false,
      message: "请选择联系方式类型",
    };
  }

  if (normalized.contactType === CONTACT_TYPES.PHONE && !isValidPhone(normalized.contact)) {
    return {
      valid: false,
      message: "请输入正确的手机号",
    };
  }

  if (normalized.contactType === CONTACT_TYPES.EMAIL && !isValidEmail(normalized.contact)) {
    return {
      valid: false,
      message: "请输入正确的邮箱",
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
    contactType: "",
  });
}

function buildInquiryRecord(draft = {}, context = {}) {
  const normalized = normalizeInquiryDraft(draft);
  return {
    inquirySchemaVersion: normalized.inquirySchemaVersion,
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
    contactType: normalized.contactType,
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
  INQUIRY_SCHEMA_VERSION,
  CONTENT_MIN_LENGTH,
  CONTENT_MAX_LENGTH,
  CONTACT_MAX_LENGTH,
  CONTACT_TYPES,
  CONTACT_TYPE_VALUES,
  buildInquiryDraftFromCase,
  buildInquiryRecord,
  getInquiryOptionLabel,
  getInquiryOptionGroups,
  isValidEmail,
  isValidPhone,
  normalizeContactType,
  normalizeInquiryDraft,
  validateInquiryDraft,
};
