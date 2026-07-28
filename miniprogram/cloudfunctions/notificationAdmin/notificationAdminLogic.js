const ANNOUNCEMENT_TYPES = ["version_update", "product_new"];
const PUBLISH_STATUSES = ["draft", "published", "hidden"];
const VALID_NOTIFICATION_ADMIN_ACTIONS = [
  "checkAccess",
  "listAnnouncements",
  "getAnnouncement",
  "createAnnouncement",
  "updateAnnouncement",
  "publishAnnouncement",
  "setAnnouncementVisibility",
  "getDeliverySummary",
  "deleteAnnouncement",
  "getPublishedLinkedCases",
];
const TITLE_MAX_LENGTH = 80;
const CONTENT_MAX_LENGTH = 500;
const VERSION_MAX_LENGTH = 30;
const CASE_LINK_LIMIT = 20;

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getAdminOpenidsFromEnv(value) {
  return trimText(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isAdminOpenid(openid, envValue) {
  return Boolean(openid && getAdminOpenidsFromEnv(envValue).includes(openid));
}

function normalizeAnnouncementType(value) {
  return ANNOUNCEMENT_TYPES.includes(value) ? value : "";
}

function sanitizeTargetPage(value) {
  const page = trimText(value);
  return page.startsWith("/pages/") ? page.slice(0, 300) : "";
}

function normalizeCaseDocIds(value, fallback = "") {
  const rawValues = Array.isArray(value)
    ? value
    : value && Array.isArray(value.values)
      ? value.values
      : [value || fallback];
  const seen = new Set();
  return rawValues
    .flatMap((item) => trimText(item).split(/[,，;；\s]+/))
    .map(trimText)
    .filter(Boolean)
    .filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
}

function sameCaseDocIds(left, right) {
  const leftIds = normalizeCaseDocIds(left);
  const rightIds = normalizeCaseDocIds(right);
  return leftIds.length === rightIds.length
    && leftIds.every((id, index) => id === rightIds[index]);
}

function buildNotificationCasesPage(id) {
  const announcementId = trimText(id);
  return announcementId
    ? `/pages/notification-cases/index?announcementId=${encodeURIComponent(announcementId)}`
    : "/pages/notifications/index";
}

function sanitizeAnnouncement(input = {}, options = {}) {
  const type = normalizeAnnouncementType(trimText(input.type));
  const title = trimText(input.title);
  const content = trimText(input.content);
  const version = trimText(input.version);
  const caseDocIds = normalizeCaseDocIds(input.caseDocIds, input.caseDocId);
  const caseDocId = caseDocIds[0] || "";
  const targetPage = sanitizeTargetPage(input.targetPage);

  if (!type) {
    return { valid: false, code: "INVALID_TYPE", message: "请选择通知类型" };
  }
  if (!title) {
    return { valid: false, code: "INVALID_TITLE", message: "请填写通知标题" };
  }
  if (title.length > TITLE_MAX_LENGTH) {
    return { valid: false, code: "INVALID_TITLE", message: "通知标题最多 80 个字" };
  }
  if (!content) {
    return { valid: false, code: "INVALID_CONTENT", message: "请填写通知内容" };
  }
  if (content.length > CONTENT_MAX_LENGTH) {
    return { valid: false, code: "INVALID_CONTENT", message: "通知内容最多 500 个字" };
  }
  if (version.length > VERSION_MAX_LENGTH) {
    return { valid: false, code: "INVALID_VERSION", message: "版本号最多 30 个字符" };
  }
  if (caseDocIds.length > CASE_LINK_LIMIT) {
    return { valid: false, code: "TOO_MANY_CASES", message: `一条产品通知最多关联 ${CASE_LINK_LIMIT} 个案例` };
  }
  if (type === "product_new" && !caseDocIds.length) {
    return { valid: false, code: "INVALID_CASE", message: "产品上新通知需要关联案例" };
  }

  return {
    valid: true,
    data: {
      type,
      title,
      content,
      version,
      caseDocIds: type === "product_new" ? caseDocIds : [],
      caseDocId: type === "product_new" ? caseDocId : "",
      targetPage: type === "product_new"
        ? buildNotificationCasesPage(options.announcementId)
        : (targetPage || "/pages/notifications/index"),
    },
  };
}

function normalizePage(value) {
  const page = Number(value);
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}

function normalizePageSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) return 20;
  return Math.min(Math.floor(size), 50);
}

module.exports = {
  ANNOUNCEMENT_TYPES,
  CASE_LINK_LIMIT,
  CONTENT_MAX_LENGTH,
  PUBLISH_STATUSES,
  TITLE_MAX_LENGTH,
  VALID_NOTIFICATION_ADMIN_ACTIONS,
  VERSION_MAX_LENGTH,
  getAdminOpenidsFromEnv,
  isAdminOpenid,
  normalizeAnnouncementType,
  normalizeCaseDocIds,
  normalizePage,
  normalizePageSize,
  buildNotificationCasesPage,
  sameCaseDocIds,
  sanitizeAnnouncement,
};
