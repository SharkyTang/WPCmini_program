const NOTIFICATION_TYPES = {
  version_update: {
    label: "版本更新",
  },
  product_new: {
    label: "产品上新",
  },
};

const NOTIFICATION_TYPE_KEYS = Object.keys(NOTIFICATION_TYPES);
const SUBSCRIPTION_STATUSES = ["idle", "granted", "consumed", "rejected", "banned"];
const SUBSCRIPTION_TEMPLATE_ID_MIN_LENGTH = 20;

function getNotificationTypeLabel(type) {
  return (NOTIFICATION_TYPES[type] && NOTIFICATION_TYPES[type].label) || "通知";
}

function isKnownNotificationType(type) {
  return NOTIFICATION_TYPE_KEYS.includes(type);
}

function normalizeCaseDocIds(value, fallback = "") {
  const values = Array.isArray(value)
    ? value
    : value && Array.isArray(value.values)
      ? value.values
      : [value || fallback];
  const seen = new Set();
  return values
    .flatMap((item) => (typeof item === "string" ? item.trim().split(/[,，;；\s]+/) : []))
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, 20);
}

function isValidSubscriptionTemplateId(value) {
  const templateId = typeof value === "string" ? value.trim() : "";
  return (
    !["10103", "1330"].includes(templateId)
    && templateId.length >= SUBSCRIPTION_TEMPLATE_ID_MIN_LENGTH
    && templateId.length <= 100
    && /^[A-Za-z0-9_-]+$/.test(templateId)
  );
}

function getNotificationTimestamp(value) {
  if (!value) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (value instanceof Date) return value.getTime();
  if (typeof value.toDate === "function") {
    const date = value.toDate();
    return date instanceof Date ? date.getTime() : 0;
  }
  return 0;
}

function formatNotificationTime(value) {
  const timestamp = getNotificationTimestamp(value);
  if (!timestamp) return "";

  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeNotification(record = {}, fallbackType = "") {
  const type = record.type || fallbackType;
  const createdAt = record.createdAt || record.updatedAt || "";
  const id = record._id || record.id || "";
  const caseDocIds = normalizeCaseDocIds(record.caseDocIds, record.caseDocId);
  const caseDocId = caseDocIds[0] || "";
  const targetPage = type === "product_new" && id && caseDocIds.length
    ? `/pages/notification-cases/index?announcementId=${encodeURIComponent(id)}`
    : record.targetPage || "";

  return {
    id,
    type,
    typeLabel: getNotificationTypeLabel(type),
    title: record.title || "消息通知",
    content: record.content || "",
    version: record.version || "",
    caseDocId,
    caseDocIds,
    targetPage,
    hasCaseLink: type === "product_new" && Boolean(caseDocIds.length && targetPage),
    publishStatus: record.publishStatus || (record.isVisible === false ? "hidden" : "published"),
    createdAt,
    timestamp: getNotificationTimestamp(createdAt),
    timeText: formatNotificationTime(createdAt),
    isVisible: record.isVisible !== false,
    sortOrder: Number(record.sortOrder || 0),
  };
}

function normalizeNotifications(records = [], fallbackType = "") {
  return (records || [])
    .map((record) => normalizeNotification(record, fallbackType))
    .filter((item) => item.isVisible && isKnownNotificationType(item.type))
    .sort((left, right) => {
      if (right.timestamp !== left.timestamp) {
        return right.timestamp - left.timestamp;
      }
      return left.sortOrder - right.sortOrder;
    });
}

function normalizeSubscriptionStatus(status) {
  return SUBSCRIPTION_STATUSES.includes(status) ? status : "idle";
}

function normalizeSubscriptionState(value = {}) {
  return NOTIFICATION_TYPE_KEYS.reduce((state, type) => {
    const item = value[type] || {};
    state[type] = {
      type,
      templateId: item.templateId || "",
      status: normalizeSubscriptionStatus(item.status),
      granted: item.status === "granted",
    };
    return state;
  }, {});
}

module.exports = {
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_KEYS,
  SUBSCRIPTION_STATUSES,
  getNotificationTypeLabel,
  normalizeNotification,
  normalizeNotifications,
  normalizeCaseDocIds,
  normalizeSubscriptionStatus,
  normalizeSubscriptionState,
  isValidSubscriptionTemplateId,
};
