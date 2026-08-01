const cloud = require("wx-server-sdk");
const {
  buildDeliveryId,
  createLeaseOwner,
  getCompletedJobStatus,
  isJobClaimable,
  mergeJobCounts,
  toTimestamp,
} = require("./notificationDispatcherLogic");

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
const JOB_SCAN_LIMIT = 20;
const JOB_LEASE_MS = 4 * 60 * 1000;

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function ok(data = {}) {
  return { ok: true, ...data };
}

function fail(code, message) {
  return { ok: false, code, message };
}

function isDocumentNotFound(error) {
  const code = error && (error.errCode || error.code);
  const message = error && (error.errMsg || error.message);
  return (
    code === -502005
    || code === "DATABASE_DOCUMENT_NOT_EXIST"
    || /document.*not found|does not exist/i.test(message || "")
  );
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
    .limit(JOB_SCAN_LIMIT)
    .get();
  return (response.data || []).find((job) => isJobClaimable(job)) || null;
}

async function findDelivery(announcementId, openid) {
  const deliveryId = buildDeliveryId(announcementId, openid);
  const current = await getDocument(DELIVERY_LOG_COLLECTION, deliveryId);
  if (current) return current;
  const response = await db
    .collection(DELIVERY_LOG_COLLECTION)
    .where({ announcementId, openid })
    .limit(1)
    .get();
  return (response.data || [])[0] || null;
}

async function claimJob(jobId, leaseOwner) {
  const now = Date.now();
  return db.runTransaction(async (transaction) => {
    const document = transaction.collection(PUSH_JOB_COLLECTION).doc(jobId);
    const response = await document.get();
    const current = response.data || null;
    if (!isJobClaimable(current, now)) return null;
    const leaseUntil = new Date(now + JOB_LEASE_MS);
    await document.update({
      data: {
        status: "processing",
        leaseOwner,
        leaseUntil,
        updatedAt: db.serverDate(),
      },
    });
    return {
      ...current,
      status: "processing",
      leaseOwner,
      leaseUntil,
    };
  });
}

async function claimDelivery(announcement, subscription, job, leaseOwner) {
  const deliveryId = buildDeliveryId(announcement._id, subscription.openid);
  return db.runTransaction(async (transaction) => {
    const document = transaction.collection(DELIVERY_LOG_COLLECTION).doc(deliveryId);
    let existing = null;
    try {
      const response = await document.get();
      existing = response.data || null;
    } catch (error) {
      if (!isDocumentNotFound(error)) throw error;
      existing = null;
    }
    if (existing) {
      return { claimed: false, deliveryId, record: existing };
    }
    const record = {
      announcementId: announcement._id,
      jobId: job._id,
      openid: subscription.openid,
      type: announcement.type,
      status: "processing",
      leaseOwner,
      createdAt: db.serverDate(),
      updatedAt: db.serverDate(),
    };
    await document.set({ data: record });
    return { claimed: true, deliveryId, record };
  });
}

async function completeDelivery(deliveryId, data) {
  await db.collection(DELIVERY_LOG_COLLECTION).doc(deliveryId).update({
    data: {
      ...data,
      updatedAt: db.serverDate(),
    },
  });
}

async function consumeSubscription(subscription, deliveryStatus) {
  return db.runTransaction(async (transaction) => {
    const document = transaction.collection(SUBSCRIPTION_COLLECTION).doc(subscription._id);
    const response = await document.get();
    const current = response.data || null;
    if (!current || current.status !== "granted") return false;
    const expectedVersion = toTimestamp(subscription.updatedAt || subscription.grantedAt);
    const currentVersion = toTimestamp(current.updatedAt || current.grantedAt);
    if (expectedVersion && currentVersion && expectedVersion !== currentVersion) {
      // The user granted a new one-time subscription while this batch was sending.
      return false;
    }
    await document.update({
      data: {
        status: "consumed",
        consumedAt: db.serverDate(),
        lastDeliveryStatus: deliveryStatus,
        updatedAt: db.serverDate(),
      },
    });
    return true;
  });
}

async function completeJobBatch(jobId, leaseOwner, counts, options = {}) {
  return db.runTransaction(async (transaction) => {
    const document = transaction.collection(PUSH_JOB_COLLECTION).doc(jobId);
    const response = await document.get();
    const current = response.data || null;
    if (!current || current.leaseOwner !== leaseOwner) {
      return null;
    }
    const totals = mergeJobCounts(current, counts);
    const status = options.forcedStatus
      || (options.hasMore ? "pending" : getCompletedJobStatus(totals));
    await document.update({
      data: {
        status,
        ...totals,
        leaseOwner: "",
        leaseUntil: null,
        updatedAt: db.serverDate(),
        ...(status === "completed" || status === "partial_failed"
          ? { completedAt: db.serverDate() }
          : {}),
      },
    });
    return { status, ...totals };
  });
}

async function releaseJob(jobId, leaseOwner, error) {
  try {
    await db.runTransaction(async (transaction) => {
      const document = transaction.collection(PUSH_JOB_COLLECTION).doc(jobId);
      const response = await document.get();
      const current = response.data || null;
      if (!current || current.leaseOwner !== leaseOwner) return;
      await document.update({
        data: {
          status: "pending",
          leaseOwner: "",
          leaseUntil: null,
          lastError: truncate(error && error.message ? error.message : "推送任务异常", 200),
          updatedAt: db.serverDate(),
        },
      });
    });
  } catch (releaseError) {
    console.error("notification job lease release failed", releaseError);
  }
}

async function processSubscription(announcement, subscription, job, leaseOwner, templateId) {
  const previous = await findDelivery(announcement._id, subscription.openid);
  if (previous) {
    const previousStatus = ["success", "failed"].includes(previous.status)
      ? previous.status
      : "skipped";
    await consumeSubscription(subscription, previousStatus);
    return previousStatus;
  }

  const delivery = await claimDelivery(announcement, subscription, job, leaseOwner);
  if (!delivery.claimed) {
    const previousStatus = ["success", "failed"].includes(
      delivery.record && delivery.record.status
    )
      ? delivery.record.status
      : "skipped";
    await consumeSubscription(subscription, previousStatus);
    return previousStatus;
  }

  let status = "success";
  let deliveryError = null;
  try {
    await cloud.openapi.subscribeMessage.send({
      touser: subscription.openid,
      templateId,
      page: (announcement.targetPage || "/pages/notifications/index").replace(/^\//, ""),
      miniprogramState: getMiniProgramState(),
      lang: "zh_CN",
      data: buildMessageData(announcement),
    });
  } catch (error) {
    status = "failed";
    deliveryError = error;
  }

  await completeDelivery(delivery.deliveryId, {
    status,
    ...(deliveryError
      ? {
        errorCode: deliveryError.errCode || deliveryError.code || "",
        errorMessage: truncate(deliveryError.errMsg || deliveryError.message || "发送失败", 200),
      }
      : {}),
  });
  await consumeSubscription(subscription, status);
  return status;
}

async function processJob(jobId = "") {
  const candidate = await findJob(jobId);
  if (!candidate) return ok({ processed: 0, status: "idle" });
  const leaseOwner = createLeaseOwner();
  const job = await claimJob(candidate._id, leaseOwner);
  if (!job) return ok({ processed: 0, status: "busy" });

  try {
    const announcement = await getDocument(ANNOUNCEMENT_COLLECTION, job.announcementId);
    if (!announcement || announcement.publishStatus !== "published" || announcement.isVisible !== true) {
      await completeJobBatch(job._id, leaseOwner, { success: 0, failed: 0, skipped: 0 }, {
        forcedStatus: "partial_failed",
      });
      return fail("ANNOUNCEMENT_UNAVAILABLE", "通知不存在或已隐藏");
    }

    const templateId = getTemplateId(announcement.type);
    if (!isValidSubscriptionTemplateId(templateId)) {
      await completeJobBatch(job._id, leaseOwner, { success: 0, failed: 0, skipped: 0 }, {
        forcedStatus: "partial_failed",
      });
      return fail(
        "INVALID_TEMPLATE_CONFIG",
        "订阅模板配置错误，请填写当前 AppID“我的模板”中的长模板 ID，不能填写模板编号"
      );
    }

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
      const status = await processSubscription(
        announcement,
        subscription,
        job,
        leaseOwner,
        templateId
      );
      if (status === "success") counts.success += 1;
      else if (status === "failed") counts.failed += 1;
      else counts.skipped += 1;
    }

    const completion = await completeJobBatch(job._id, leaseOwner, counts, {
      hasMore: subscriptions.length === BATCH_SIZE,
    });
    const status = completion ? completion.status : "busy";
    return ok({ processed: subscriptions.length, status, counts });
  } catch (error) {
    await releaseJob(job._id, leaseOwner, error);
    throw error;
  }
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const timerInvocation = !OPENID && event.Type === "Timer";
  if (!timerInvocation && !isAdmin(OPENID)) {
    return fail("FORBIDDEN", "无权限执行通知推送");
  }
  try {
    return await processJob(trimText(event.jobId));
  } catch (error) {
    console.error("notificationDispatcher error", error);
    return fail("SERVER_ERROR", error.message || "通知推送服务异常");
  }
};

module.exports.buildMessageData = buildMessageData;
module.exports.processJob = processJob;
module.exports.buildDeliveryId = buildDeliveryId;
