const NOTIFICATION_TYPES = {
  version_update: {
    label: "版本更新",
  },
  product_new: {
    label: "产品上新",
  },
  customer_reply: {
    label: "客服回复",
  },
};

const NOTIFICATION_TYPE_KEYS = Object.keys(NOTIFICATION_TYPES);

function getNotificationTypeLabel(type) {
  return (NOTIFICATION_TYPES[type] && NOTIFICATION_TYPES[type].label) || "通知";
}

function isKnownNotificationType(type) {
  return NOTIFICATION_TYPE_KEYS.includes(type);
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

  return {
    id: record._id || record.id || "",
    type,
    typeLabel: getNotificationTypeLabel(type),
    title: record.title || "消息通知",
    content: record.content || "",
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

function normalizeDisabledTypes(disabledTypes = []) {
  return Array.from(
    new Set((disabledTypes || []).filter((type) => isKnownNotificationType(type)))
  );
}

function isNotificationTypeDisabled(disabledTypes = [], type) {
  return normalizeDisabledTypes(disabledTypes).includes(type);
}

function toggleDisabledType(disabledTypes = [], type) {
  if (!isKnownNotificationType(type)) {
    return normalizeDisabledTypes(disabledTypes);
  }

  const normalized = normalizeDisabledTypes(disabledTypes);
  if (normalized.includes(type)) {
    return normalized.filter((item) => item !== type);
  }
  return [...normalized, type];
}

module.exports = {
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_KEYS,
  getNotificationTypeLabel,
  normalizeNotification,
  normalizeNotifications,
  normalizeDisabledTypes,
  isNotificationTypeDisabled,
  toggleDisabledType,
};
