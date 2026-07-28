const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();
const _ = db.command;
const ANNOUNCEMENT_COLLECTION = "app_notifications";
const SUBSCRIPTION_COLLECTION = "notification_subscriptions";
const PUSH_JOB_COLLECTION = "notification_push_jobs";
const DELIVERY_LOG_COLLECTION = "notification_delivery_logs";
const BATCH_SIZE = 20;

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function ok(data = {}) {
  return { ok: true, ...data };
}

function fail(code, message) {
  return { ok: false, code, message };
}

function isAdmin(openid) {
  return trimText(process.env.ADMIN_OPENIDS)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .includes(openid);
}

function getTemplateId(type) {
  return type === "version_update"
    ? trimText(process.env.VERSION_UPDATE_TEMPLATE_ID)
    : trimText(process.env.PRODUCT_NEW_TEMPLATE_ID);
}

function isValidSubscriptionTemplateId(value) {
  const templateId = trimText(value);
  return (
    !["10103", "1330"].includes(templateId)
    && templateId.length >= 20
    && templateId.length <= 100
    && /^[A-Za-z0-9_-]+$/.test(templateId)
  );
}

function getMiniProgramState() {
  const value = trimText(process.env.SUBSCRIBE_MESSAGE_STATE);
  return ["developer", "trial", "formal"].includes(value) ? value : "formal";
}

function parseFieldMap(type) {
  const raw = type === "version_update"
    ? process.env.VERSION_UPDATE_TEMPLATE_FIELDS
    : process.env.PRODUCT_NEW_TEMPLATE_FIELDS;
  const fallback = type === "version_update"
    ? { title: "thing4", content: "thing5", time: "time7" }
    : { title: "thing1", time: "date2", content: "thing3" };
  if (!raw) return fallback;
  try {
    return { ...fallback, ...JSON.parse(raw) };
  } catch (error) {
    console.warn("invalid subscription field map", error);
    return fallback;
  }
}

function truncate(value, maxLength) {
  return trimText(value).slice(0, maxLength);
}

function formatTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDate(value = new Date()) {
  return formatTime(value).slice(0, 10);
}

function buildMessageData(announcement = {}) {
  const fields = parseFieldMap(announcement.type);
  const values = {
    title: truncate(announcement.title, 20),
    content: truncate(announcement.content, 20),
    version: truncate(announcement.version || "最新版本", 20),
  };
  return Object.keys(fields).reduce((data, logicalKey) => {
    const keyword = fields[logicalKey];
    const value = logicalKey === "time"
      ? (keyword.startsWith("date")
        ? formatDate(announcement.publishedAt || new Date())
        : formatTime(announcement.publishedAt || new Date()))
      : values[logicalKey];
    if (keyword && value) {
      data[keyword] = { value };
    }
    return data;
  }, {});
}

async function getDocument(collectionName, id) {
  try {
    const response = await db.collection(collectionName).doc(id).get();
    return response.data || null;
  } catch (error) {
    return null;
  }
}

async function findJob(jobId) {
  if (jobId) return getDocument(PUSH_JOB_COLLECTION, jobId);
  const response = await db
    .collection(PUSH_JOB_COLLECTION)
    .where({ status: _.in(["pending", "processing"]) })
    .orderBy("createdAt", "asc")
    .limit(1)
    .get();
  return (response.data || [])[0] || null;
}

async function findDelivery(announcementId, openid) {
  const response = await db
    .collection(DELIVERY_LOG_COLLECTION)
    .where({ announcementId, openid })
    .limit(1)
    .get();
  return (response.data || [])[0] || null;
}

async function addDeliveryLog(data) {
  await db.collection(DELIVERY_LOG_COLLECTION).add({
    data: {
      ...data,
      createdAt: db.serverDate(),
    },
  });
}

async function consumeSubscription(subscription, deliveryStatus) {
  await db.collection(SUBSCRIPTION_COLLECTION).doc(subscription._id).update({
    data: {
      status: "consumed",
      consumedAt: db.serverDate(),
      lastDeliveryStatus: deliveryStatus,
      updatedAt: db.serverDate(),
    },
  });
}

async function updateJob(job, counts, status = "processing") {
  await db.collection(PUSH_JOB_COLLECTION).doc(job._id).update({
    data: {
      status,
      successCount: Number(job.successCount || 0) + counts.success,
      failedCount: Number(job.failedCount || 0) + counts.failed,
      skippedCount: Number(job.skippedCount || 0) + counts.skipped,
      updatedAt: db.serverDate(),
      ...(status === "completed" || status === "partial_failed"
        ? { completedAt: db.serverDate() }
        : {}),
    },
  });
}

async function processJob(jobId = "") {
  const job = await findJob(jobId);
  if (!job) return ok({ processed: 0, status: "idle" });

  const announcement = await getDocument(ANNOUNCEMENT_COLLECTION, job.announcementId);
  if (!announcement || announcement.publishStatus !== "published" || announcement.isVisible !== true) {
    await updateJob(job, { success: 0, failed: 0, skipped: 0 }, "partial_failed");
    return fail("ANNOUNCEMENT_UNAVAILABLE", "通知不存在或已隐藏");
  }

  const templateId = getTemplateId(announcement.type);
  if (!isValidSubscriptionTemplateId(templateId)) {
    await updateJob(job, { success: 0, failed: 0, skipped: 0 }, "partial_failed");
    return fail(
      "INVALID_TEMPLATE_CONFIG",
      "订阅模板配置错误，请填写当前 AppID“我的模板”中的长模板 ID，不能填写模板编号"
    );
  }

  await db.collection(PUSH_JOB_COLLECTION).doc(job._id).update({
    data: {
      status: "processing",
      updatedAt: db.serverDate(),
    },
  });

  const subscriptionResponse = await db
    .collection(SUBSCRIPTION_COLLECTION)
    .where({
      type: announcement.type,
      templateId,
      status: "granted",
      grantedAt: _.lte(announcement.publishedAt),
    })
    .limit(BATCH_SIZE)
    .get();
  const subscriptions = subscriptionResponse.data || [];
  const counts = { success: 0, failed: 0, skipped: 0 };

  for (const subscription of subscriptions) {
    const previous = await findDelivery(announcement._id, subscription.openid);
    if (previous) {
      counts.skipped += 1;
      await consumeSubscription(subscription, "skipped");
      continue;
    }

    try {
      await cloud.openapi.subscribeMessage.send({
        touser: subscription.openid,
        templateId,
        page: (announcement.targetPage || "/pages/notifications/index").replace(/^\//, ""),
        miniprogramState: getMiniProgramState(),
        lang: "zh_CN",
        data: buildMessageData(announcement),
      });
      counts.success += 1;
      await addDeliveryLog({
        announcementId: announcement._id,
        jobId: job._id,
        openid: subscription.openid,
        type: announcement.type,
        status: "success",
      });
      await consumeSubscription(subscription, "success");
    } catch (error) {
      counts.failed += 1;
      await addDeliveryLog({
        announcementId: announcement._id,
        jobId: job._id,
        openid: subscription.openid,
        type: announcement.type,
        status: "failed",
        errorCode: error.errCode || error.code || "",
        errorMessage: truncate(error.errMsg || error.message || "发送失败", 200),
      });
      await consumeSubscription(subscription, "failed");
    }
  }

  if (subscriptions.length === BATCH_SIZE) {
    await updateJob(job, counts, "pending");
    return ok({ processed: subscriptions.length, status: "pending", counts });
  }

  const finalFailed = Number(job.failedCount || 0) + counts.failed;
  const finalStatus = finalFailed > 0 ? "partial_failed" : "completed";
  await updateJob(job, counts, finalStatus);
  return ok({ processed: subscriptions.length, status: finalStatus, counts });
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const timerInvocation = !OPENID && event.Type === "Timer";
  if (!timerInvocation && !isAdmin(OPENID)) {
    return fail("FORBIDDEN", "无权限执行通知推送");
  }
  try {
    return processJob(trimText(event.jobId));
  } catch (error) {
    console.error("notificationDispatcher error", error);
    return fail("SERVER_ERROR", error.message || "通知推送服务异常");
  }
};

module.exports.buildMessageData = buildMessageData;
module.exports.processJob = processJob;
