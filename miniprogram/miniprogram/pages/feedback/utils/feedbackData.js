const FEEDBACK_TYPES = [
  { key: "bug", label: "遇到问题" },
  { key: "suggestion", label: "体验建议" },
  { key: "feature", label: "想要的功能" },
  { key: "case_data", label: "图片或分类不对" },
];

const FEEDBACK_TYPE_LABELS = FEEDBACK_TYPES.reduce((labels, item) => {
  labels[item.key] = item.label;
  return labels;
}, {});

const CONTENT_MIN_LENGTH = 5;
const CONTENT_MAX_LENGTH = 800;
const CONTACT_MAX_LENGTH = 120;
const CONTACT_TYPES = Object.freeze({
  WECHAT: "wechat",
  PHONE: "phone",
  EMAIL: "email",
});
const CONTACT_TYPE_VALUES = Object.freeze(Object.values(CONTACT_TYPES));

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
    return {
      valid: false,
      message: "请选择反馈类型",
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
      message: "内容最多 800 个字",
    };
  }

  if (normalized.contact.length > CONTACT_MAX_LENGTH) {
    return {
      valid: false,
      message: "联系方式最多 120 个字",
    };
  }

  if (normalized.contact && rawContactType && !normalized.contactType) {
    return {
      valid: false,
      message: "联系方式类型无效",
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
    systemInfo: context.systemInfo && typeof context.systemInfo === "object"
      ? context.systemInfo
      : {},
    status: "new",
  };
}

module.exports = {
  FEEDBACK_TYPES,
  CONTENT_MIN_LENGTH,
  CONTENT_MAX_LENGTH,
  CONTACT_MAX_LENGTH,
  CONTACT_TYPES,
  CONTACT_TYPE_VALUES,
  buildFeedbackRecord,
  isValidEmail,
  isValidPhone,
  normalizeContactType,
  normalizeFeedbackDraft,
  validateFeedbackDraft,
};
