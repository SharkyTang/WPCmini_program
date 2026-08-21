const crypto = require("crypto");

const INQUIRY_COLLECTION = "inquiries";
const INQUIRY_MESSAGE_COLLECTION = "inquiry_messages";
const INQUIRY_ALERT_JOB_COLLECTION = "inquiry_alert_jobs";
const INQUIRY_REPLY_SUBSCRIPTION_COLLECTION = "inquiry_reply_subscriptions";
const INQUIRY_SCHEMA_VERSION = 2;
const FEEDBACK_COLLECTION = "feedback";
const NOTIFICATION_SUBSCRIPTION_COLLECTION = "notification_subscriptions";
const USER_PROFILE_NICKNAME_MAX_LENGTH = 14;

const INQUIRY_CONTENT_MIN_LENGTH = 5;
const INQUIRY_CONTENT_MAX_LENGTH = 800;
const INQUIRY_CONTACT_MAX_LENGTH = 120;
const FEEDBACK_CONTENT_MIN_LENGTH = 5;
const FEEDBACK_CONTENT_MAX_LENGTH = 800;
const FEEDBACK_CONTACT_MAX_LENGTH = 120;
const CONTACT_TYPES = Object.freeze({
  WECHAT: "wechat",
  PHONE: "phone",
  EMAIL: "email",
});
const CONTACT_TYPE_VALUES = Object.freeze(Object.values(CONTACT_TYPES));

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
    platform: trimText(value.platform),
    system: trimText(value.system),
    version: trimText(value.version),
    SDKVersion: trimText(value.SDKVersion),
  };
}

function normalizeInquiryDraft(draft = {}) {
  const schemaVersion = Number(draft.inquirySchemaVersion);
  return {
    inquirySchemaVersion: Number.isInteger(schemaVersion) && schemaVersion > 0
      ? schemaVersion
      : 0,
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
    return { valid: false, code: "INVALID_INQUIRY", message: "请选择包装内容" };
  }
  if (normalized.content.length < INQUIRY_CONTENT_MIN_LENGTH) {
    return { valid: false, code: "INVALID_INQUIRY", message: "请至少填写 5 个字" };
  }
  if (normalized.content.length > INQUIRY_CONTENT_MAX_LENGTH) {
    return { valid: false, code: "INVALID_INQUIRY", message: "补充说明最多 800 个字" };
  }
  if (!normalized.contact) {
    const message = normalized.contactType === CONTACT_TYPES.PHONE
      ? "请输入手机号"
      : normalized.contactType === CONTACT_TYPES.EMAIL
        ? "请输入邮箱"
        : normalized.contactType === CONTACT_TYPES.WECHAT
          ? "请输入微信号"
          : "请填写联系方式";
    return { valid: false, code: "INVALID_INQUIRY", message };
  }
  if (normalized.contact.length > INQUIRY_CONTACT_MAX_LENGTH) {
    return { valid: false, code: "INVALID_INQUIRY", message: "联系方式最多 120 个字" };
  }
  // 兼容没有 contactType 的旧客户端；非空非法值拒绝入库。
  if (rawContactType && !normalized.contactType) {
    return { valid: false, code: "INVALID_INQUIRY", message: "联系方式类型无效" };
  }
  if (
    normalized.inquirySchemaVersion >= INQUIRY_SCHEMA_VERSION
    && !normalized.contactType
  ) {
    return { valid: false, code: "INVALID_INQUIRY", message: "请选择联系方式类型" };
  }
  if (normalized.contactType === CONTACT_TYPES.PHONE && !isValidPhone(normalized.contact)) {
    return { valid: false, code: "INVALID_INQUIRY", message: "请输入正确的手机号" };
  }
  if (normalized.contactType === CONTACT_TYPES.EMAIL && !isValidEmail(normalized.contact)) {
    return { valid: false, code: "INVALID_INQUIRY", message: "请输入正确的邮箱" };
  }

  return { valid: true, data: normalized };
}

function buildInquiryRecord(draft = {}, context = {}) {
  const normalized = normalizeInquiryDraft(draft);
  const isCurrentSchema = normalized.inquirySchemaVersion >= INQUIRY_SCHEMA_VERSION;
  return {
    inquirySchemaVersion: isCurrentSchema ? INQUIRY_SCHEMA_VERSION : 1,
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
    contactTypeSource: normalized.contactType ? "customer_selected" : "legacy_missing",
    sourcePage: trimText(context.sourcePage),
    route: trimText(context.route),
    openid: trimText(context.openid),
    appVersion: trimText(context.appVersion) || "v2.8",
    systemInfo: normalizeSystemInfo(context.systemInfo),
    status: "new",
    claimedByOpenid: "",
    claimedBy: "",
    claimedAt: null,
    lastAdminReplyAt: null,
    lastAdminReplyPreview: "",
    replyCount: 0,
    customerUnreadCount: 0,
    customerLastReadAt: null,
    // Durable notifier queue marker. This is stored even while email is off,
    // so a later timer can recover a failed best-effort invocation.
    alertTaskStatus: "pending",
    alertTaskPlanVersion: "",
    alertTaskStopReason: "",
    alertTaskUpdatedAt: null,
  };
}

function buildInquiryReplySubscriptionId(inquiryId, openid) {
  const digest = crypto
    .createHash("sha256")
    .update(`${trimText(inquiryId)}\n${trimText(openid)}`)
    .digest("hex")
    .slice(0, 28);
  // Keep the complete custom document ID at 32 characters for CloudBase.
  return `irs_${digest}`;
}

function normalizeFeedbackDraft(draft = {}) {
  const type = trimText(draft.type);
  const contact = trimText(draft.contact);
  return {
    type,
    typeLabel: FEEDBACK_TYPE_LABELS[type] || "",
    content: trimText(draft.content),
    contact,
    contactType: contact ? normalizeContactType(draft.contactType) : "",
  };
}

function validateFeedbackDraft(draft = {}) {
  const normalized = normalizeFeedbackDraft(draft);
  const rawContactType = trimText(draft.contactType).toLowerCase();

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
  if (normalized.contact && rawContactType && !normalized.contactType) {
    return { valid: false, code: "INVALID_FEEDBACK", message: "联系方式类型无效" };
  }
  if (normalized.contactType === CONTACT_TYPES.PHONE && !isValidPhone(normalized.contact)) {
    return { valid: false, code: "INVALID_FEEDBACK", message: "请输入正确的手机号" };
  }
  if (normalized.contactType === CONTACT_TYPES.EMAIL && !isValidEmail(normalized.contact)) {
    return { valid: false, code: "INVALID_FEEDBACK", message: "请输入正确的邮箱" };
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
    contactType: normalized.contactType,
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
  INQUIRY_ALERT_JOB_COLLECTION,
  INQUIRY_COLLECTION,
  INQUIRY_MESSAGE_COLLECTION,
  INQUIRY_REPLY_SUBSCRIPTION_COLLECTION,
  INQUIRY_SCHEMA_VERSION,
  NOTIFICATION_SUBSCRIPTION_COLLECTION,
  NOTIFICATION_TYPE_KEYS,
  CONTACT_TYPES,
  CONTACT_TYPE_VALUES,
  buildFeedbackRecord,
  buildInquiryRecord,
  buildInquiryReplySubscriptionId,
  USER_PROFILE_NICKNAME_MAX_LENGTH,
  normalizeNotificationType,
  normalizeSubscriptionStatus,
  buildTemplateConfig,
  isValidSubscriptionTemplateId,
  isValidEmail,
  isValidPhone,
  normalizeContactType,
  normalizeUserProfileDraft,
  pickPreferenceRecord,
  validateSubscriptionGrant,
  validateUserProfileDraft,
  validateFeedbackDraft,
  validateInquiryDraft,
};
