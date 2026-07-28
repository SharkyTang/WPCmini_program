const INQUIRY_COLLECTION = "inquiries";
const FEEDBACK_COLLECTION = "feedback";
const NOTIFICATION_SUBSCRIPTION_COLLECTION = "notification_subscriptions";
const USER_PROFILE_NICKNAME_MAX_LENGTH = 14;

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
];
const SUBSCRIPTION_STATUS_KEYS = ["accept", "reject", "ban"];
const SUBSCRIPTION_TEMPLATE_ID_MIN_LENGTH = 20;

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

function normalizeNotificationType(value) {
  return NOTIFICATION_TYPE_KEYS.includes(value) ? value : "";
}

function normalizeSubscriptionStatus(value) {
  if (value === "accept") return "granted";
  if (value === "reject") return "rejected";
  if (value === "ban") return "banned";
  return "";
}

function isValidSubscriptionTemplateId(value) {
  const templateId = trimText(value);
  if (!templateId || ["10103", "1330"].includes(templateId)) return false;
  return (
    templateId.length >= SUBSCRIPTION_TEMPLATE_ID_MIN_LENGTH
    && templateId.length <= 100
    && /^[A-Za-z0-9_-]+$/.test(templateId)
  );
}

function buildTemplateConfig(type, templateId) {
  const normalizedId = trimText(templateId);
  const envKey = type === "version_update"
    ? "VERSION_UPDATE_TEMPLATE_ID"
    : "PRODUCT_NEW_TEMPLATE_ID";
  const valid = isValidSubscriptionTemplateId(normalizedId);
  return {
    type,
    envKey,
    templateId: normalizedId,
    valid,
    code: valid ? "" : "INVALID_TEMPLATE_CONFIG",
    message: valid
      ? ""
      : `${envKey} 配置错误，请填写当前小程序“我的模板”中的长模板 ID，不能填写模板编号`,
  };
}

function validateSubscriptionGrant(input = {}, templateIds = {}) {
  const type = normalizeNotificationType(trimText(input.type));
  const templateId = trimText(input.templateId);
  const rawStatus = trimText(input.status);
  const status = normalizeSubscriptionStatus(rawStatus);

  if (!type || !templateId || !SUBSCRIPTION_STATUS_KEYS.includes(rawStatus) || !status) {
    return { valid: false, code: "INVALID_SUBSCRIPTION", message: "订阅状态无效" };
  }
  if (!isValidSubscriptionTemplateId(templateIds[type])) {
    return { valid: false, code: "INVALID_TEMPLATE_CONFIG", message: buildTemplateConfig(type, templateIds[type]).message };
  }
  if (templateIds[type] !== templateId) {
    return { valid: false, code: "INVALID_TEMPLATE", message: "订阅模板配置不匹配" };
  }
  return {
    valid: true,
    data: {
      type,
      templateId,
      status,
    },
  };
}

function normalizeUserProfileDraft(profile = {}) {
  const source = profile && typeof profile === "object" ? profile : {};
  return {
    nickname: trimText(source.nickname),
    avatarFileId: trimText(source.avatarFileId),
  };
}

function validateUserProfileDraft(profile = {}) {
  const normalized = normalizeUserProfileDraft(profile);

  if (!normalized.nickname) {
    return { valid: false, code: "INVALID_PROFILE", message: "请输入昵称" };
  }
  if (normalized.nickname.length > USER_PROFILE_NICKNAME_MAX_LENGTH) {
    return {
      valid: false,
      code: "INVALID_PROFILE",
      message: `昵称最多 ${USER_PROFILE_NICKNAME_MAX_LENGTH} 个字符`,
    };
  }
  if (!normalized.avatarFileId || normalized.avatarFileId.indexOf("cloud://") !== 0) {
    return { valid: false, code: "INVALID_PROFILE", message: "请先选择头像" };
  }

  return { valid: true, data: normalized };
}

function pickPreferenceRecord(records = []) {
  return (records || [])[0] || null;
}

module.exports = {
  FEEDBACK_COLLECTION,
  INQUIRY_COLLECTION,
  NOTIFICATION_SUBSCRIPTION_COLLECTION,
  NOTIFICATION_TYPE_KEYS,
  buildFeedbackRecord,
  buildInquiryRecord,
  USER_PROFILE_NICKNAME_MAX_LENGTH,
  normalizeNotificationType,
  normalizeSubscriptionStatus,
  buildTemplateConfig,
  isValidSubscriptionTemplateId,
  normalizeUserProfileDraft,
  pickPreferenceRecord,
  validateSubscriptionGrant,
  validateUserProfileDraft,
  validateFeedbackDraft,
  validateInquiryDraft,
};
