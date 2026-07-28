const cloud = require("wx-server-sdk");
const {
  isAdminOpenid,
  normalizePage,
  normalizePageSize,
  sanitizeAnnouncement,
} = require("./notificationAdminLogic");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();
const ANNOUNCEMENT_COLLECTION = "app_notifications";
const PUSH_JOB_COLLECTION = "notification_push_jobs";
const DELIVERY_LOG_COLLECTION = "notification_delivery_logs";

function ok(data = {}) {
  return { ok: true, ...data };
}

function fail(code, message) {
  return { ok: false, code, message };
}

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

async function getAnnouncementById(id) {
  if (!id) return null;
  try {
    const response = await db.collection(ANNOUNCEMENT_COLLECTION).doc(id).get();
    return response.data || null;
  } catch (error) {
    return null;
  }
}

async function listAnnouncements(event) {
  const page = normalizePage(event.page);
  const pageSize = normalizePageSize(event.pageSize);
  const response = await db
    .collection(ANNOUNCEMENT_COLLECTION)
    .orderBy("createdAt", "desc")
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get();
  return ok({
    items: response.data || [],
    page,
    pageSize,
    hasMore: (response.data || []).length === pageSize,
  });
}

async function getAnnouncement(event) {
  const id = trimText(event.id);
  if (!id) return fail("INVALID_ID", "缺少通知 ID");
  const item = await getAnnouncementById(id);
  if (!item) return fail("ANNOUNCEMENT_NOT_FOUND", "通知不存在");
  return ok({ item });
}

async function findProductAnnouncement(caseDocId) {
  if (!caseDocId) return null;
  const response = await db
    .collection(ANNOUNCEMENT_COLLECTION)
    .where({
      type: "product_new",
      caseDocId,
    })
    .limit(1)
    .get();
  return (response.data || [])[0] || null;
}

async function createAnnouncement(event, openid) {
  const validation = sanitizeAnnouncement(event.announcement || event.data || {});
  if (!validation.valid) return fail(validation.code, validation.message);

  if (validation.data.type === "product_new") {
    const existing = await findProductAnnouncement(validation.data.caseDocId);
    if (existing) {
      return ok({
        id: existing._id,
        reused: true,
        publishStatus: existing.publishStatus || "draft",
      });
    }
  }

  const response = await db.collection(ANNOUNCEMENT_COLLECTION).add({
    data: {
      ...validation.data,
      isVisible: false,
      publishStatus: "draft",
      createdAt: db.serverDate(),
      updatedAt: db.serverDate(),
      createdByOpenid: openid,
      updatedByOpenid: openid,
    },
  });
  return ok({
    id: response._id || "",
    reused: false,
    publishStatus: "draft",
  });
}

async function updateAnnouncement(event, openid) {
  const id = trimText(event.id);
  if (!id) return fail("INVALID_ID", "缺少通知 ID");
  const existing = await getAnnouncementById(id);
  if (!existing) return fail("ANNOUNCEMENT_NOT_FOUND", "通知不存在");
  const validation = sanitizeAnnouncement(event.announcement || event.data || {});
  if (!validation.valid) return fail(validation.code, validation.message);
  const publishStatus = existing.publishStatus || "published";
  if (publishStatus !== "draft") {
    if (validation.data.type !== existing.type) {
      return fail("TYPE_LOCKED", "已发布通知不能修改通知类型");
    }
    if (
      existing.type === "product_new"
      && validation.data.caseDocId !== trimText(existing.caseDocId)
    ) {
      return fail("CASE_LOCKED", "已发布产品通知不能修改关联案例");
    }
  }
  await db.collection(ANNOUNCEMENT_COLLECTION).doc(id).update({
    data: {
      ...validation.data,
      updatedAt: db.serverDate(),
      updatedByOpenid: openid,
    },
  });
  return ok({ id });
}

async function findPushJob(announcementId) {
  const response = await db
    .collection(PUSH_JOB_COLLECTION)
    .where({ announcementId })
    .limit(1)
    .get();
  return (response.data || [])[0] || null;
}

async function createOrResumePushJob(announcement, openid) {
  const existing = await findPushJob(announcement._id);
  if (existing && existing.status === "completed") return existing;
  if (existing && existing._id) {
    await db.collection(PUSH_JOB_COLLECTION).doc(existing._id).update({
      data: {
        status: "pending",
        updatedAt: db.serverDate(),
        updatedByOpenid: openid,
      },
    });
    return { ...existing, status: "pending" };
  }

  const response = await db.collection(PUSH_JOB_COLLECTION).add({
    data: {
      announcementId: announcement._id,
      type: announcement.type,
      status: "pending",
      successCount: 0,
      failedCount: 0,
      skippedCount: 0,
      createdAt: db.serverDate(),
      updatedAt: db.serverDate(),
      createdByOpenid: openid,
    },
  });
  return {
    _id: response._id || "",
    status: "pending",
  };
}

async function publishAnnouncement(event, openid) {
  const id = trimText(event.id);
  if (!id) return fail("INVALID_ID", "缺少通知 ID");
  const existing = await getAnnouncementById(id);
  if (!existing) return fail("ANNOUNCEMENT_NOT_FOUND", "通知不存在");

  await db.collection(ANNOUNCEMENT_COLLECTION).doc(id).update({
    data: {
      isVisible: true,
      publishStatus: "published",
      publishedAt: existing.publishedAt || db.serverDate(),
      updatedAt: db.serverDate(),
      updatedByOpenid: openid,
    },
  });

  let pushJob = null;
  if (event.sendSubscription === true) {
    pushJob = await createOrResumePushJob({ ...existing, _id: id }, openid);
  }
  return ok({
    id,
    publishStatus: "published",
    pushJobId: pushJob ? pushJob._id || "" : "",
  });
}

async function setAnnouncementVisibility(event, openid) {
  const id = trimText(event.id);
  if (!id) return fail("INVALID_ID", "缺少通知 ID");
  const existing = await getAnnouncementById(id);
  if (!existing) return fail("ANNOUNCEMENT_NOT_FOUND", "通知不存在");
  const isVisible = event.isVisible === true;
  if (isVisible && (existing.publishStatus || "draft") === "draft") {
    return fail("DRAFT_NOT_PUBLISHED", "草稿需要先发布");
  }
  await db.collection(ANNOUNCEMENT_COLLECTION).doc(id).update({
    data: {
      isVisible,
      publishStatus: isVisible ? "published" : "hidden",
      updatedAt: db.serverDate(),
      updatedByOpenid: openid,
    },
  });
  return ok({
    id,
    isVisible,
    publishStatus: isVisible ? "published" : "hidden",
  });
}

async function getDeliverySummary(event) {
  const announcementId = trimText(event.id || event.announcementId);
  if (!announcementId) return fail("INVALID_ID", "缺少通知 ID");
  const job = await findPushJob(announcementId);
  return ok({
    summary: job
      ? {
          jobId: job._id || "",
          status: job.status || "pending",
          successCount: Number(job.successCount || 0),
          failedCount: Number(job.failedCount || 0),
          skippedCount: Number(job.skippedCount || 0),
        }
      : {
          jobId: "",
          status: "not_requested",
          successCount: 0,
          failedCount: 0,
          skippedCount: 0,
        },
  });
}

async function deleteAnnouncement(event) {
  const id = trimText(event.id);
  if (!id) return fail("INVALID_ID", "缺少通知 ID");
  const existing = await getAnnouncementById(id);
  if (!existing) return fail("ANNOUNCEMENT_NOT_FOUND", "通知不存在");

  const pushJob = await findPushJob(id);
  if (pushJob && ["pending", "processing"].includes(pushJob.status)) {
    return fail("PUSH_IN_PROGRESS", "通知推送正在进行，请稍后再删除");
  }

  await db.collection(ANNOUNCEMENT_COLLECTION).doc(id).remove();
  await db.collection(PUSH_JOB_COLLECTION).where({ announcementId: id }).remove();
  await db.collection(DELIVERY_LOG_COLLECTION).where({ announcementId: id }).remove();
  return ok({ id });
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const action = trimText(event.action);
  const admin = isAdminOpenid(OPENID, process.env.ADMIN_OPENIDS);

  if (action === "checkAccess") {
    return ok({ isAdmin: admin });
  }
  if (!admin) {
    return fail("FORBIDDEN", "无权限管理通知");
  }

  try {
    if (action === "listAnnouncements") return listAnnouncements(event);
    if (action === "getAnnouncement") return getAnnouncement(event);
    if (action === "createAnnouncement") return createAnnouncement(event, OPENID);
    if (action === "updateAnnouncement") return updateAnnouncement(event, OPENID);
    if (action === "publishAnnouncement") return publishAnnouncement(event, OPENID);
    if (action === "setAnnouncementVisibility") {
      return setAnnouncementVisibility(event, OPENID);
    }
    if (action === "getDeliverySummary") return getDeliverySummary(event);
    if (action === "deleteAnnouncement") return deleteAnnouncement(event);
    return fail("UNKNOWN_ACTION", "未知通知管理操作");
  } catch (error) {
    console.error("notificationAdmin error", error);
    return fail("SERVER_ERROR", error.message || "通知管理服务异常");
  }
};
