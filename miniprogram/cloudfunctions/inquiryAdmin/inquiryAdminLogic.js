const crypto = require("crypto");

const VALID_CONTACT_TYPES = ["wechat", "phone", "email"];
const REPLY_MAX_LENGTH = 300;
const MUTATION_ID_MAX_LENGTH = 128;
const TEMPLATE_VALUE_MAX_LENGTH = 128;
const FORBIDDEN_REPLY_TARGET_FIELDS = [
  "openid",
  "customerOpenid",
  "customerOpenId",
  "targetOpenid",
  "targetOpenId",
];

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function countCharacters(value) {
  return Array.from(value || "").length;
}

function containsInvalidControlCharacters(value) {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value || "");
}

function normalizeReplyContent(value) {
  if (typeof value !== "string") {
    return { valid: false, value: "", reason: "回复内容不能为空" };
  }
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  const length = countCharacters(normalized);
  if (!length) {
    return { valid: false, value: "", reason: "回复内容不能为空" };
  }
  if (length > REPLY_MAX_LENGTH) {
    return {
      valid: false,
      value: "",
      reason: `回复内容最多 ${REPLY_MAX_LENGTH} 个字`,
    };
  }
  if (containsInvalidControlCharacters(normalized)) {
    return { valid: false, value: "", reason: "回复内容只能包含纯文本" };
  }
  return { valid: true, value: normalized, reason: "" };
}

function normalizeClientMutationId(value) {
  const normalized = trimText(value);
  if (
    !normalized
    || normalized.length > MUTATION_ID_MAX_LENGTH
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)
  ) {
    return {
      valid: false,
      value: "",
      reason: "缺少有效的 clientMutationId",
    };
  }
  return { valid: true, value: normalized, reason: "" };
}

function hasForbiddenReplyTarget(event = {}) {
  return FORBIDDEN_REPLY_TARGET_FIELDS.some((field) => (
    Object.prototype.hasOwnProperty.call(event, field)
  ));
}

function normalizeContactType(value) {
  const normalized = trimText(value).toLowerCase();
  return VALID_CONTACT_TYPES.includes(normalized) ? normalized : "";
}

function buildDeterministicDocumentId(prefix, ...parts) {
  const digest = crypto
    .createHash("sha256")
    .update(parts.map((part) => trimText(part)).join("\n"))
    .digest("hex")
    .slice(0, 32);
  return `${prefix}_${digest}`;
}

function buildReplyMessageId(inquiryId, openid, clientMutationId) {
  return buildDeterministicDocumentId(
    "reply",
    inquiryId,
    openid,
    clientMutationId
  );
}

function buildReplyEventId(messageId) {
  return buildDeterministicDocumentId("event", "reply", messageId);
}

function getClaimedBy(item = {}) {
  return trimText(item.claimedByOpenid) || trimText(item.claimedBy);
}

function buildClaimSummary(item = {}) {
  const claimedBy = getClaimedBy(item);
  if (!claimedBy) return null;
  return {
    claimedBy,
    claimedByOpenid: claimedBy,
    claimedAt: item.claimedAt || null,
  };
}

function buildLastReplySummary(item = {}) {
  if (!item.repliedAt && !trimText(item.lastReplyPreview)) return null;
  return {
    content: trimText(item.lastReplyPreview),
    createdAt: item.repliedAt || null,
    createdByOpenid: trimText(item.lastRepliedBy),
  };
}

function enrichInquiryItem(item = {}) {
  const claimedBy = getClaimedBy(item);
  return {
    ...item,
    ...(claimedBy
      ? {
        claimedByOpenid: claimedBy,
        claimedBy: trimText(item.claimedBy) || claimedBy,
      }
      : {}),
    claim: buildClaimSummary(item),
    lastReply: buildLastReplySummary(item),
  };
}

function isValidTemplateId(value) {
  const templateId = trimText(value);
  return (
    templateId.length >= 20
    && templateId.length <= 100
    && /^[A-Za-z0-9_-]+$/.test(templateId)
  );
}

function normalizeMiniProgramState(value) {
  const normalized = trimText(value);
  return ["developer", "trial", "formal"].includes(normalized)
    ? normalized
    : "formal";
}

function formatTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
}

function parseReplyTemplateFieldEntries(rawValue) {
  const sourceText = typeof rawValue === "string" ? rawValue : "";
  const raw = sourceText.trim();
  if (!raw) return null;

  let entries;
  if (raw.startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    entries = Object.entries(parsed);
    const sourceSemanticNames = [];
    const semanticKeyPattern = /"(title|content|remark|time)"\s*:/g;
    let match;
    while ((match = semanticKeyPattern.exec(raw))) {
      sourceSemanticNames.push(match[1]);
    }
    if (
      sourceSemanticNames.length !== entries.length
      || new Set(sourceSemanticNames).size !== sourceSemanticNames.length
    ) {
      return null;
    }
  } else {
    if (/[\r\n]/.test(sourceText)) return null;
    const parts = raw.split(",");
    if (!parts.length || parts.some((part) => !trimText(part))) return null;
    entries = [];
    for (const part of parts) {
      const separatorIndex = part.indexOf("=");
      if (
        separatorIndex <= 0
        || separatorIndex !== part.lastIndexOf("=")
        || separatorIndex >= part.length - 1
      ) {
        return null;
      }
      entries.push([
        trimText(part.slice(0, separatorIndex)),
        trimText(part.slice(separatorIndex + 1)),
      ]);
    }
  }

  if (!entries.length) return null;
  const allowedSemanticNames = new Set(["title", "content", "remark", "time"]);
  const semanticNames = new Set();
  const templateFields = new Set();
  const normalizedEntries = [];
  for (const [semanticName, templateField] of entries) {
    const normalizedSemanticName = trimText(semanticName);
    const normalizedTemplateField = trimText(templateField);
    if (
      !allowedSemanticNames.has(normalizedSemanticName)
      || semanticNames.has(normalizedSemanticName)
      || templateFields.has(normalizedTemplateField)
      || !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(normalizedTemplateField)
    ) {
      return null;
    }
    semanticNames.add(normalizedSemanticName);
    templateFields.add(normalizedTemplateField);
    normalizedEntries.push([normalizedSemanticName, normalizedTemplateField]);
  }
  return normalizedEntries;
}

function parseReplyTemplateFields(rawValue) {
  const entries = parseReplyTemplateFieldEntries(rawValue);
  if (!entries) return { valid: false, data: null };

  const semanticValues = {
    title: "需求处理进度更新",
    content: "管理员已回复，请进入小程序查看",
    remark: "请进入我的需求查看详情",
    time: formatTime(),
  };
  const data = {};
  for (const [semanticName, fieldName] of entries) {
    const value = trimText(semanticValues[semanticName]);
    if (
      !value
      || value.length > TEMPLATE_VALUE_MAX_LENGTH
    ) {
      return { valid: false, data: null };
    }
    data[fieldName] = { value };
  }
  return Object.keys(data).length
    ? { valid: true, data }
    : { valid: false, data: null };
}

function truncateText(value, maxLength) {
  return Array.from(trimText(value)).slice(0, maxLength).join("");
}

function normalizeSafeErrorCode(error) {
  const rawValue = error && (error.errCode || error.code);
  const rawCode = typeof rawValue === "number"
    ? String(rawValue)
    : trimText(rawValue);
  const normalized = rawCode
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "_")
    .slice(0, 48);
  return normalized || "PUSH_FAILED";
}

module.exports = {
  FORBIDDEN_REPLY_TARGET_FIELDS,
  MUTATION_ID_MAX_LENGTH,
  REPLY_MAX_LENGTH,
  TEMPLATE_VALUE_MAX_LENGTH,
  VALID_CONTACT_TYPES,
  buildClaimSummary,
  buildLastReplySummary,
  buildReplyEventId,
  buildReplyMessageId,
  containsInvalidControlCharacters,
  countCharacters,
  enrichInquiryItem,
  formatTime,
  getClaimedBy,
  hasForbiddenReplyTarget,
  isValidTemplateId,
  normalizeClientMutationId,
  normalizeContactType,
  normalizeMiniProgramState,
  normalizeReplyContent,
  normalizeSafeErrorCode,
  parseReplyTemplateFields,
  trimText,
  truncateText,
};
