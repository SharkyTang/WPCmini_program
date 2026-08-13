const CUSTOMER_SERVICE_SOURCE = {
  PROFILE: "profile",
  DETAIL: "detail",
};

const MAX_SESSION_FROM_LENGTH = 240;
const DEFAULT_CUSTOMER_MESSAGE_TITLE = "咨询同款包装方案";

function normalizeSource(source) {
  if (source === CUSTOMER_SERVICE_SOURCE.DETAIL) return CUSTOMER_SERVICE_SOURCE.DETAIL;
  return CUSTOMER_SERVICE_SOURCE.PROFILE;
}

function normalizeValue(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function stringifySession(parts) {
  return parts
    .filter((part) => part.value)
    .map((part) => `${part.key}=${encodeURIComponent(part.value)}`)
    .join("&");
}

function buildCustomerMessageCard(options = {}) {
  const caseItem = options.caseItem || {};
  const caseReferenceId =
    normalizeValue(caseItem.id, 120) ||
    normalizeValue(caseItem._id, 120) ||
    normalizeValue(caseItem.caseId, 120);
  const caseTitle = normalizeValue(caseItem.title, 80);
  const requestedImageUrl =
    typeof options.imageUrl === "string" ? options.imageUrl.trim() : "";
  const fallbackImageUrl =
    typeof caseItem.coverImageUrl === "string" ? caseItem.coverImageUrl.trim() : "";
  const imageUrl = requestedImageUrl || fallbackImageUrl;

  return {
    enabled: Boolean(caseReferenceId),
    title: caseTitle ? `咨询同款：${caseTitle}` : DEFAULT_CUSTOMER_MESSAGE_TITLE,
    path: caseReferenceId
      ? `/pages/detail/index?id=${encodeURIComponent(caseReferenceId)}`
      : "",
    imageUrl,
  };
}

function buildCustomerSessionFrom(options = {}) {
  const source = normalizeSource(options.source);
  if (source === CUSTOMER_SERVICE_SOURCE.PROFILE) {
    return "source=profile";
  }

  const caseItem = options.caseItem || {};
  let title = normalizeValue(caseItem.title, 80);
  const baseParts = [
    { key: "source", value: CUSTOMER_SERVICE_SOURCE.DETAIL },
    { key: "caseDocId", value: normalizeValue(caseItem._id, 80) },
    { key: "caseId", value: normalizeValue(caseItem.caseId, 60) },
  ];

  let sessionFrom = stringifySession([...baseParts, { key: "title", value: title }]);
  while (sessionFrom.length > MAX_SESSION_FROM_LENGTH && title.length > 0) {
    title = title.slice(0, -1);
    sessionFrom = stringifySession([...baseParts, { key: "title", value: title }]);
  }

  return sessionFrom.length <= MAX_SESSION_FROM_LENGTH
    ? sessionFrom
    : stringifySession(baseParts).slice(0, MAX_SESSION_FROM_LENGTH);
}

module.exports = {
  CUSTOMER_SERVICE_SOURCE,
  DEFAULT_CUSTOMER_MESSAGE_TITLE,
  MAX_SESSION_FROM_LENGTH,
  buildCustomerMessageCard,
  buildCustomerSessionFrom,
};
