const { normalizeNotification } = require("./notificationData");

const NOTIFICATION_ADMIN_FUNCTION = "notificationAdmin";
const NOTIFICATION_DISPATCHER_FUNCTION = "notificationDispatcher";
const DEFAULT_PAGE_SIZE = 20;

function normalizeFunctionResult(response) {
  const result = (response && response.result) || {};
  if (result.ok === false) {
    const error = new Error(result.message || "通知管理请求失败");
    error.code = result.code || "NOTIFICATION_ADMIN_ERROR";
    throw error;
  }
  return result;
}

async function callNotificationAdmin(action, payload = {}) {
  if (!wx.cloud) throw new Error("当前基础库不支持云开发");
  const response = await wx.cloud.callFunction({
    name: NOTIFICATION_ADMIN_FUNCTION,
    data: { action, ...payload },
  });
  return normalizeFunctionResult(response);
}

function normalizeAdminAnnouncement(record = {}) {
  const item = normalizeNotification(record);
  const publishStatus = record.publishStatus || (record.isVisible === false ? "hidden" : "published");
  const statusLabels = {
    draft: "草稿",
    published: "已发布",
    hidden: "已隐藏",
  };
  return {
    ...item,
    publishStatus,
    publishStatusLabel: statusLabels[publishStatus] || "未知状态",
    canEdit: true,
    canPublish: publishStatus === "draft",
    canToggleVisibility: publishStatus === "published" || publishStatus === "hidden",
    canShowDeliverySummary: publishStatus === "published" || publishStatus === "hidden",
    isVisible: record.isVisible === true,
  };
}

async function checkNotificationAdminAccess() {
  try {
    const result = await callNotificationAdmin("checkAccess");
    return Boolean(result.isAdmin);
  } catch (error) {
    console.warn("通知管理权限检查失败", error);
    return false;
  }
}

async function fetchAnnouncementList(options = {}) {
  const result = await callNotificationAdmin("listAnnouncements", {
    page: options.page || 1,
    pageSize: options.pageSize || DEFAULT_PAGE_SIZE,
  });
  return {
    items: (result.items || []).map(normalizeAdminAnnouncement),
    page: result.page || 1,
    pageSize: result.pageSize || DEFAULT_PAGE_SIZE,
    hasMore: Boolean(result.hasMore),
  };
}

async function fetchAnnouncementDetail(id) {
  const result = await callNotificationAdmin("getAnnouncement", { id });
  return normalizeAdminAnnouncement(result.item || {});
}

async function createAnnouncement(announcement) {
  return callNotificationAdmin("createAnnouncement", { announcement });
}

async function updateAnnouncement(id, announcement) {
  return callNotificationAdmin("updateAnnouncement", { id, announcement });
}

async function runDispatcher(jobId) {
  if (!jobId || !wx.cloud) return null;
  try {
    const response = await wx.cloud.callFunction({
      name: NOTIFICATION_DISPATCHER_FUNCTION,
      data: { jobId },
    });
    return normalizeFunctionResult(response);
  } catch (error) {
    console.warn("通知任务已创建，将由定时任务继续处理", error);
    return null;
  }
}

async function publishAnnouncement(id, sendSubscription) {
  const result = await callNotificationAdmin("publishAnnouncement", {
    id,
    sendSubscription: sendSubscription === true,
  });
  if (result.pushJobId) {
    await runDispatcher(result.pushJobId);
  }
  return result;
}

async function setAnnouncementVisibility(id, isVisible) {
  return callNotificationAdmin("setAnnouncementVisibility", { id, isVisible });
}

async function fetchDeliverySummary(id) {
  const result = await callNotificationAdmin("getDeliverySummary", { id });
  return result.summary || {};
}

async function deleteAnnouncement(id) {
  return callNotificationAdmin("deleteAnnouncement", { id });
}

async function publishProductAnnouncement(input = {}) {
  const createResult = await createAnnouncement({
    type: "product_new",
    title: input.title,
    content: input.content,
    caseDocId: input.caseDocId,
    targetPage: `/pages/detail/index?id=${encodeURIComponent(input.caseDocId || "")}`,
  });
  return publishAnnouncement(createResult.id, input.sendSubscription !== false);
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  checkNotificationAdminAccess,
  createAnnouncement,
  deleteAnnouncement,
  fetchAnnouncementDetail,
  fetchAnnouncementList,
  fetchDeliverySummary,
  publishAnnouncement,
  publishProductAnnouncement,
  setAnnouncementVisibility,
  updateAnnouncement,
};
