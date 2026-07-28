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
];
const TITLE_MAX_LENGTH = 80;
const CONTENT_MAX_LENGTH = 500;
const VERSION_MAX_LENGTH = 30;

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

function sanitizeAnnouncement(input = {}) {
  const type = normalizeAnnouncementType(trimText(input.type));
  const title = trimText(input.title);
  const content = trimText(input.content);
  const version = trimText(input.version);
  const caseDocId = trimText(input.caseDocId);
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
  if (type === "product_new" && !caseDocId) {
    return { valid: false, code: "INVALID_CASE", message: "产品上新通知需要关联案例" };
  }

  return {
    valid: true,
    data: {
      type,
      title,
      content,
      version,
      caseDocId,
      targetPage: targetPage || (
        type === "product_new"
          ? `/pages/detail/index?id=${encodeURIComponent(caseDocId)}`
          : "/pages/notifications/index"
      ),
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
  CONTENT_MAX_LENGTH,
  PUBLISH_STATUSES,
  TITLE_MAX_LENGTH,
  VALID_NOTIFICATION_ADMIN_ACTIONS,
  VERSION_MAX_LENGTH,
  getAdminOpenidsFromEnv,
  isAdminOpenid,
  normalizeAnnouncementType,
  normalizePage,
  normalizePageSize,
  sanitizeAnnouncement,
};
