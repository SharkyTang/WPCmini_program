const crypto = require("crypto");
const cloud = require("wx-server-sdk");
const {
  buildClaimSummary,
  buildReplyEventId,
  buildReplyMessageId,
  enrichInquiryItem,
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
} = require("./inquiryAdminLogic");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command || {};
const INQUIRY_COLLECTION = "inquiries";
const MESSAGE_COLLECTION = "inquiry_messages";
const EVENT_COLLECTION = "inquiry_admin_events";
const ALERT_JOB_COLLECTION = "inquiry_alert_jobs";
const REPLY_SUBSCRIPTION_COLLECTION = "inquiry_reply_subscriptions";
const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 50;
const FILTER_SCAN_BATCH_SIZE = 100;
const SEARCH_KEYWORD_MAX_LENGTH = 80;
const MESSAGE_FETCH_LIMIT = 100;
const ALERT_JOB_FETCH_LIMIT = 100;
const VALID_STATUSES = ["new", "contacted", "processing", "done", "invalid"];
const ADMIN_NOTE_MAX_LENGTH = 500;
const ALERT_JOB_TERMINAL_STATUSES = new Set([
  "sent",
  "cancelled",
  "failed",
  "permanent_failed",
  "delivery_unknown",
  "completed",
]);

function ok(data = {}) {
  return { ok: true, ...data };
}

function fail(code, message, data = {}) {
  return { ok: false, code, message, ...data };
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

function getAdminOpenids() {
  const configuredAdmins = trimText(process.env.INQUIRY_ADMIN_OPENIDS)
    || trimText(process.env.ADMIN_OPENIDS);
  return configuredAdmins
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isAdmin(openid) {
  return Boolean(openid && getAdminOpenids().includes(openid));
}

function isFeatureEnabled(name) {
  return trimText(process.env[name]).toLowerCase() === "true";
}

function getFeatureFlags() {
  const followupEnabled = isFeatureEnabled("INQUIRY_FOLLOWUP_ENABLED");
  return {
    followupEnabled,
    emailAlertsEnabled: followupEnabled
      && isFeatureEnabled("INQUIRY_EMAIL_ALERTS_ENABLED"),
    customerPushEnabled: followupEnabled
      && isFeatureEnabled("INQUIRY_CUSTOMER_PUSH_ENABLED"),
  };
}

function normalizePage(value) {
  const page = Number(value);
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}

function normalizePageSize(value) {
  const pageSize = Number(value);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return PAGE_SIZE_DEFAULT;
  return Math.min(Math.floor(pageSize), PAGE_SIZE_MAX);
}

function normalizeStatus(status) {
  return VALID_STATUSES.includes(status) ? status : "new";
}

function toTimestamp(value) {
  if (!value) return 0;
  if (typeof value === "object" && value.$date) return toTimestamp(value.$date);
  if (typeof value === "object" && typeof value.toDate === "function") {
    return value.toDate().getTime();
  }
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createListQueryKey({ status, filter, keyword, openid }) {
  return crypto
    .createHash("sha256")
    .update([
      VALID_STATUSES.includes(status) ? status : "all",
      normalizeClaimFilter(filter),
      trimText(keyword).toLowerCase(),
      normalizeClaimFilter(filter) === "mine" ? trimText(openid) : "",
    ].join("\n"))
    .digest("hex")
    .slice(0, 24);
}

function encodeListCursor(item, queryKey) {
  const timestamp = toTimestamp(item && item.createdAt);
  const id = getDocumentId(item);
  if (!timestamp || !id) return "";
  return JSON.stringify({
    v: 1,
    k: "admin_inquiry",
    t: timestamp,
    id,
    q: queryKey,
  });
}

function parseListCursor(value, queryKey) {
  const text = trimText(value);
  if (!text) return { valid: true, cursor: null };
  if (text.length > 768) return { valid: false, cursor: null };
  try {
    const parsed = JSON.parse(text);
    const timestamp = Number(parsed && parsed.t);
    const id = trimText(parsed && parsed.id);
    if (
      !parsed
      || parsed.v !== 1
      || parsed.k !== "admin_inquiry"
      || trimText(parsed.q) !== queryKey
      || !Number.isFinite(timestamp)
      || timestamp <= 0
      || !id
      || id.length > 128
      || id.includes("/")
    ) {
      return { valid: false, cursor: null };
    }
    return { valid: true, cursor: { timestamp, id } };
  } catch (error) {
    return { valid: false, cursor: null };
  }
}

function buildSearchText(item = {}) {
  return [
    item.contact,
    item.caseId,
    item.caseTitle,
    item.content,
    Array.isArray(item.packageTypes) ? item.packageTypes.join(" ") : "",
    Array.isArray(item.scenes) ? item.scenes.join(" ") : "",
  ].join(" ").toLowerCase();
}

function filterByKeyword(items, keyword) {
  const normalizedKeyword = trimText(keyword).toLowerCase();
  if (!normalizedKeyword) return items;
  return items.filter((item) => buildSearchText(item).includes(normalizedKeyword));
}

function normalizeClaimFilter(value) {
  return ["unclaimed", "mine"].includes(value) ? value : "all";
}

function filterByClaim(items, filter, openid) {
  if (filter === "mine") {
    return items.filter((item) => getClaimedBy(item) === openid);
  }
  if (filter === "unclaimed") {
    return items.filter((item) => !getClaimedBy(item));
  }
  return items;
}

function createEventId(type) {
  return `${type}_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;
}

async function readDocument(databaseApi, collectionName, id) {
  try {
    const response = await databaseApi.collection(collectionName).doc(id).get();
    return response.data || null;
  } catch (error) {
    if (isDocumentNotFound(error)) return null;
    throw error;
  }
}

function getDocumentId(item) {
  return trimText(item && (item._id || item.id));
}

async function listInquiriesLegacy(event, openid) {
  const page = normalizePage(event.page);
  const pageSize = normalizePageSize(event.pageSize);
  const keyword = trimText(event.keyword);
  const status = event.status;
  const filter = normalizeClaimFilter(event.filter);
  const hasStatusFilter = VALID_STATUSES.includes(status);
  const hasClaimFilter = filter !== "all";
  const createQuery = () => {
    let query = db.collection(INQUIRY_COLLECTION);
    if (hasStatusFilter) query = query.where({ status });
    return query.orderBy("createdAt", "desc");
  };
  const start = (page - 1) * pageSize;

  if (keyword || hasClaimFilter) {
    const requiredMatches = start + pageSize + 1;
    const filteredItems = [];
    let scanned = 0;
    let exhausted = false;
    while (filteredItems.length < requiredMatches && !exhausted) {
      const response = await createQuery()
        .skip(scanned)
        .limit(FILTER_SCAN_BATCH_SIZE)
        .get();
      const batch = response.data || [];
      scanned += batch.length;
      exhausted = batch.length < FILTER_SCAN_BATCH_SIZE;
      filteredItems.push(...filterByKeyword(
        filterByClaim(batch, filter, openid),
        keyword
      ));
    }
    return ok({
      items: filteredItems
        .slice(start, start + pageSize)
        .map(enrichInquiryItem),
      page,
      pageSize,
      hasMore: filteredItems.length > start + pageSize,
    });
  }

  const response = await createQuery()
    .skip(start)
    .limit(pageSize)
    .get();
  const items = (response.data || [])
    .filter((item) => !hasStatusFilter || normalizeStatus(item.status) === status)
    .map(enrichInquiryItem);
  return ok({
    items,
    page,
    pageSize,
    hasMore: items.length === pageSize,
  });
}

function buildClaimQueryCondition(filter, openid) {
  if (filter === "mine") {
    return _.or([
      { claimedByOpenid: openid },
      { claimedByOpenid: _.exists(false), claimedBy: openid },
      { claimedByOpenid: "", claimedBy: openid },
    ]);
  }
  if (filter === "unclaimed") {
    return _.or([
      { claimedByOpenid: "", claimedBy: "" },
      { claimedByOpenid: "", claimedBy: _.exists(false) },
      { claimedByOpenid: _.exists(false), claimedBy: "" },
      { claimedByOpenid: _.exists(false), claimedBy: _.exists(false) },
    ]);
  }
  return null;
}

function buildKeywordQueryCondition(keyword) {
  if (!keyword) return null;
  const expression = db.RegExp({
    regexp: escapeRegExp(keyword),
    options: "i",
  });
  return _.or([
    { contact: expression },
    { caseId: expression },
    { caseTitle: expression },
    { content: expression },
  ]);
}

async function listInquiriesByCursor(event, openid) {
  const pageSize = normalizePageSize(event.pageSize);
  const keyword = trimText(event.keyword);
  if (Array.from(keyword).length > SEARCH_KEYWORD_MAX_LENGTH) {
    return fail("INVALID_KEYWORD", `搜索关键词最多 ${SEARCH_KEYWORD_MAX_LENGTH} 个字`);
  }
  const status = event.status;
  const filter = normalizeClaimFilter(event.filter);
  const queryKey = createListQueryKey({ status, filter, keyword, openid });
  const parsedCursor = parseListCursor(event.cursor, queryKey);
  if (!parsedCursor.valid) return fail("INVALID_CURSOR", "需求列表游标无效");

  const conditions = [];
  if (VALID_STATUSES.includes(status)) conditions.push({ status });
  const claimCondition = buildClaimQueryCondition(filter, openid);
  if (claimCondition) conditions.push(claimCondition);
  const keywordCondition = buildKeywordQueryCondition(keyword);
  if (keywordCondition) conditions.push(keywordCondition);
  if (parsedCursor.cursor) {
    const cursorDate = new Date(parsedCursor.cursor.timestamp);
    conditions.push(_.or([
      { createdAt: _.lt(cursorDate) },
      { createdAt: cursorDate, _id: _.lt(parsedCursor.cursor.id) },
    ]));
  }

  let query = db.collection(INQUIRY_COLLECTION);
  if (conditions.length === 1) query = query.where(conditions[0]);
  if (conditions.length > 1) query = query.where(_.and(conditions));
  const response = await query
    .orderBy("createdAt", "desc")
    .orderBy("_id", "desc")
    .limit(pageSize + 1)
    .get();
  const rows = response.data || [];
  const hasMore = rows.length > pageSize;
  const visibleRows = rows.slice(0, pageSize);
  const nextCursor = hasMore
    ? encodeListCursor(visibleRows[visibleRows.length - 1], queryKey)
    : "";
  return ok({
    items: visibleRows.map(enrichInquiryItem),
    page: normalizePage(event.page),
    pageSize,
    nextCursor,
    hasMore: Boolean(nextCursor),
  });
}

async function listInquiries(event, openid) {
  // Cursor-aware clients always include the cursor key, including an empty
  // string on the first page. Keep the former page/skip path for a staged
  // backend-first rollout so an already-published admin page can still load.
  if (Object.prototype.hasOwnProperty.call(event, "cursor")) {
    return listInquiriesByCursor(event, openid);
  }
  return listInquiriesLegacy(event, openid);
}

async function listInquiryMessages(inquiryId) {
  try {
    const response = await db.collection(MESSAGE_COLLECTION)
      .where({ inquiryId })
      .orderBy("createdAt", "asc")
      .limit(MESSAGE_FETCH_LIMIT)
      .get();
    return (response.data || [])
      .filter((message) => (
        message.customerVisible !== false
        && (!trimText(message.direction) || message.direction === "admin_to_customer")
      ))
      .map((message) => ({
        ...message,
        id: getDocumentId(message) || trimText(message.id),
      }));
  } catch (error) {
    // Keep getInquiry compatible during the staged collection rollout.
    console.warn("failed to load inquiry messages", {
      code: normalizeSafeErrorCode(error),
    });
    return [];
  }
}

async function getInquiry(event) {
  const id = trimText(event.id);
  if (!id) return fail("INVALID_ID", "缺少需求 ID");
  const item = await readDocument(db, INQUIRY_COLLECTION, id);
  if (!item) return fail("NOT_FOUND", "需求不存在");
  const messages = await listInquiryMessages(id);
  return ok({ item: enrichInquiryItem(item), messages });
}

async function countDocuments(condition) {
  let query = db.collection(INQUIRY_COLLECTION);
  if (condition) query = query.where(condition);
  const response = await query.count();
  return Number(response.total || 0);
}

async function countEmailAlertIssues() {
  const issueStatuses = ["permanent_failed", "failed", "delivery_unknown"];
  try {
    if (typeof _.in === "function") {
      const response = await db.collection(ALERT_JOB_COLLECTION)
        .where({ status: _.in(issueStatuses) })
        .count();
      return Math.max(0, Number(response.total || 0));
    }
    const counts = await Promise.all(issueStatuses.map(async (status) => {
      const response = await db.collection(ALERT_JOB_COLLECTION)
        .where({ status })
        .count();
      return Math.max(0, Number(response.total || 0));
    }));
    return counts.reduce((total, count) => total + count, 0);
  } catch (error) {
    // Summary remains usable before the alert collection is deployed.
    console.warn("failed to count inquiry email alert issues", {
      code: normalizeSafeErrorCode(error),
    });
    return 0;
  }
}

function normalizeHealthToken(value, fallback) {
  const normalized = trimText(value).toLowerCase();
  return /^[a-z0-9_-]{1,48}$/.test(normalized) ? normalized : fallback;
}

async function getEmailNotifierHealth() {
  if (typeof cloud.callFunction !== "function") {
    return {
      emailNotifierStatus: "unknown",
      emailNotifierReason: "health_unavailable",
    };
  }
  try {
    const response = await cloud.callFunction({
      name: "inquiryNotifier",
      data: {
        action: "health",
        internalToken: process.env.INQUIRY_NOTIFIER_INTERNAL_TOKEN || "",
      },
    });
    const result = (response && response.result) || {};
    if (result.ok === false) {
      return {
        emailNotifierStatus: "unknown",
        emailNotifierReason: "health_check_failed",
      };
    }
    return {
      emailNotifierStatus: normalizeHealthToken(result.status, "unknown"),
      emailNotifierReason: normalizeHealthToken(result.reason, ""),
    };
  } catch (error) {
    console.warn("failed to read inquiry notifier health");
    return {
      emailNotifierStatus: "unknown",
      emailNotifierReason: "health_unavailable",
    };
  }
}

async function getInquirySummary(event, openid) {
  const flags = getFeatureFlags();
  const statusCountsPromise = Promise.all(
    VALID_STATUSES.map((status) => countDocuments({ status }))
  );
  const supportsExists = typeof _.exists === "function";
  const supportsNonEmpty = supportsExists && typeof _.neq === "function";
  const nonEmptyClaim = supportsNonEmpty
    ? _.neq("").and(_.exists(true))
    : null;
  const canonicalAssignedPromise = supportsNonEmpty
    ? countDocuments({ claimedByOpenid: nonEmptyClaim })
    : Promise.resolve(0);
  const legacyMissingAssignedPromise = supportsNonEmpty
    ? countDocuments({
      claimedByOpenid: _.exists(false),
      claimedBy: nonEmptyClaim,
    })
    : Promise.resolve(0);
  const legacyEmptyAssignedPromise = supportsNonEmpty
    ? countDocuments({ claimedByOpenid: "", claimedBy: nonEmptyClaim })
    : Promise.resolve(0);
  const canonicalMinePromise = countDocuments({ claimedByOpenid: openid });
  const legacyMissingMinePromise = supportsExists
    ? countDocuments({ claimedByOpenid: _.exists(false), claimedBy: openid })
    : countDocuments({ claimedBy: openid });
  const legacyEmptyMinePromise = supportsExists
    ? countDocuments({ claimedByOpenid: "", claimedBy: openid })
    : Promise.resolve(0);
  const [
    total,
    statusCounts,
    canonicalMineCount,
    legacyMissingMineCount,
    legacyEmptyMineCount,
    canonicalAssignedCount,
    legacyMissingAssignedCount,
    legacyEmptyAssignedCount,
    emailAlertIssueCount,
    emailNotifierHealth,
  ] = await Promise.all([
    countDocuments(),
    statusCountsPromise,
    canonicalMinePromise,
    legacyMissingMinePromise,
    legacyEmptyMinePromise,
    canonicalAssignedPromise,
    legacyMissingAssignedPromise,
    legacyEmptyAssignedPromise,
    flags.emailAlertsEnabled ? countEmailAlertIssues() : Promise.resolve(0),
    flags.emailAlertsEnabled
      ? getEmailNotifierHealth()
      : Promise.resolve({
        emailNotifierStatus: "disabled",
        emailNotifierReason: "feature_disabled",
      }),
  ]);
  const byStatus = VALID_STATUSES.reduce((result, status, index) => {
    result[status] = statusCounts[index];
    return result;
  }, {});
  const assignedCount = canonicalAssignedCount
    + legacyMissingAssignedCount
    + legacyEmptyAssignedCount;
  return ok({
    ...flags,
    total,
    newCount: byStatus.new,
    contactedCount: byStatus.contacted,
    processingCount: byStatus.processing,
    doneCount: byStatus.done,
    invalidCount: byStatus.invalid,
    unclaimedCount: supportsNonEmpty
      ? Math.max(0, total - assignedCount)
      : null,
    mineCount: canonicalMineCount
      + legacyMissingMineCount
      + legacyEmptyMineCount,
    emailAlertIssueCount,
    ...emailNotifierHealth,
    byStatus,
  });
}

async function updateInquiryStatus(event, openid) {
  const id = trimText(event.id);
  if (!id) return fail("INVALID_ID", "缺少需求 ID");
  const status = trimText(event.status);
  if (!VALID_STATUSES.includes(status)) {
    return fail("INVALID_STATUS", "需求状态无效");
  }
  await db.collection(INQUIRY_COLLECTION).doc(id).update({
    data: {
      status,
      updatedAt: db.serverDate(),
      updatedByOpenid: openid,
    },
  });
  return ok({ status });
}

async function saveInquiryNote(event, openid) {
  const id = trimText(event.id);
  const adminNote = trimText(event.adminNote);
  if (!id) return fail("INVALID_ID", "缺少需求 ID");
  if (adminNote.length > ADMIN_NOTE_MAX_LENGTH) {
    return fail("INVALID_NOTE", "管理员备注最多 500 个字");
  }
  await db.collection(INQUIRY_COLLECTION).doc(id).update({
    data: {
      adminNote,
      updatedAt: db.serverDate(),
      updatedByOpenid: openid,
    },
  });
  return ok({ adminNote });
}

async function writeAdminEvent(transaction, eventId, data) {
  await transaction.collection(EVENT_COLLECTION).doc(eventId).set({
    data: {
      id: eventId,
      ...data,
      createdAt: db.serverDate(),
    },
  });
}

async function cancelInquiryAlertJobs(inquiryId, stopReason) {
  try {
    const response = await db.collection(ALERT_JOB_COLLECTION)
      .where({ inquiryId })
      .limit(ALERT_JOB_FETCH_LIMIT)
      .get();
    const jobs = (response.data || []).filter((job) => (
      getDocumentId(job) && !ALERT_JOB_TERMINAL_STATUSES.has(job.status)
    ));
    await Promise.all(jobs.map((job) => (
      db.collection(ALERT_JOB_COLLECTION).doc(getDocumentId(job)).update({
        data: {
          status: "cancelled",
          stopReason,
          leaseOwner: "",
          leaseUntil: null,
          stoppedAt: db.serverDate(),
          updatedAt: db.serverDate(),
        },
      })
    )));
    return jobs.length;
  } catch (error) {
    // The notifier also re-checks inquiry state before delivery.
    console.warn("failed to cancel inquiry alert jobs", {
      code: normalizeSafeErrorCode(error),
    });
    return 0;
  }
}

async function mutateClaim(event, openid, allowTakeOver) {
  const id = trimText(event.id);
  if (!id) return fail("INVALID_ID", "缺少需求 ID");
  const expectedClaimedBy = trimText(event.expectedClaimedBy);
  if (allowTakeOver && !expectedClaimedBy) {
    return fail("INVALID_EXPECTED_CLAIM", "请刷新后重新确认接手");
  }
  const eventId = createEventId(
    allowTakeOver ? "inquiry_taken_over" : "inquiry_claimed"
  );
  const result = await db.runTransaction(async (transaction) => {
    const document = transaction.collection(INQUIRY_COLLECTION).doc(id);
    const response = await document.get().catch((error) => {
      if (isDocumentNotFound(error)) return { data: null };
      throw error;
    });
    const current = response.data || null;
    if (!current) return fail("NOT_FOUND", "需求不存在");
    const previousClaimedBy = getClaimedBy(current);
    if (previousClaimedBy === openid) {
      return ok({
        id,
        claim: buildClaimSummary(current),
        idempotent: true,
      });
    }
    if (allowTakeOver && previousClaimedBy !== expectedClaimedBy) {
      return fail("CLAIM_CONFLICT", "跟进人已变更，请重新确认", {
        claim: buildClaimSummary(current),
      });
    }
    if (previousClaimedBy && !allowTakeOver) {
      return fail("CLAIM_CONFLICT", "该需求已被其他管理员认领", {
        claim: buildClaimSummary(current),
      });
    }

    const claimedAt = db.serverDate();
    await document.update({
      data: {
        claimedByOpenid: openid,
        claimedBy: openid,
        claimedAt,
        updatedAt: db.serverDate(),
        updatedByOpenid: openid,
      },
    });
    await writeAdminEvent(transaction, eventId, {
      inquiryId: id,
      type: previousClaimedBy ? "inquiry_taken_over" : "inquiry_claimed",
      actorOpenid: openid,
      before: {
        claimedBy: previousClaimedBy,
        claimedAt: current.claimedAt || null,
      },
      after: { claimedBy: openid },
    });
    return ok({
      id,
      claim: { claimedBy: openid, claimedByOpenid: openid, claimedAt },
      idempotent: false,
      takenOver: Boolean(previousClaimedBy),
    });
  });

  if (result.ok) {
    result.cancelledAlertJobCount = await cancelInquiryAlertJobs(id, "claimed");
  }
  return result;
}

async function claimInquiry(event, openid) {
  return mutateClaim(event, openid, false);
}

async function takeOverInquiry(event, openid) {
  return mutateClaim(event, openid, true);
}

function buildReplyMessageResult(message = {}) {
  return {
    _id: getDocumentId(message),
    id: getDocumentId(message),
    inquiryId: trimText(message.inquiryId),
    content: trimText(message.content),
    createdAt: message.createdAt || null,
    createdByOpenid: trimText(message.createdByOpenid),
  };
}

function getReplyPushConfiguration() {
  const enabled = isFeatureEnabled("INQUIRY_FOLLOWUP_ENABLED")
    && isFeatureEnabled("INQUIRY_CUSTOMER_PUSH_ENABLED");
  const templateId = trimText(process.env.INQUIRY_REPLY_TEMPLATE_ID);
  const fields = parseReplyTemplateFields(
    process.env.INQUIRY_REPLY_TEMPLATE_FIELDS
  );
  if (!enabled || !isValidTemplateId(templateId) || !fields.valid) {
    return { enabled: false };
  }
  return {
    enabled: true,
    templateId,
    data: fields.data,
    miniprogramState: normalizeMiniProgramState(
      process.env.SUBSCRIBE_MESSAGE_STATE
    ),
  };
}

async function findGrantedReplySubscription(inquiryId, openid, templateId) {
  const response = await db.collection(REPLY_SUBSCRIPTION_COLLECTION)
    .where({ inquiryId, openid })
    .limit(20)
    .get();
  return (response.data || [])
    .find((item) => (
      trimText(item.templateId) === templateId && item.status === "granted"
    )) || null;
}

async function reserveReplySubscription(subscription, inquiryId, openid, templateId) {
  const subscriptionId = getDocumentId(subscription);
  if (!subscriptionId) return null;
  const reservationId = crypto.randomBytes(16).toString("hex");
  return db.runTransaction(async (transaction) => {
    const document = transaction.collection(REPLY_SUBSCRIPTION_COLLECTION)
      .doc(subscriptionId);
    const response = await document.get().catch((error) => {
      if (isDocumentNotFound(error)) return { data: null };
      throw error;
    });
    const current = response.data || null;
    if (
      !current
      || current.status !== "granted"
      || trimText(current.inquiryId) !== inquiryId
      || trimText(current.openid) !== openid
      || trimText(current.templateId) !== templateId
    ) {
      return null;
    }
    await document.update({
      data: {
        status: "sending",
        reservationId,
        sendingAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });
    return { ...current, _id: subscriptionId, reservationId };
  });
}

async function completeReplySubscription(
  subscriptionId,
  reservationId,
  deliveryStatus,
  deliveryErrorCode
) {
  return db.runTransaction(async (transaction) => {
    const document = transaction.collection(REPLY_SUBSCRIPTION_COLLECTION)
      .doc(subscriptionId);
    const response = await document.get().catch((error) => {
      if (isDocumentNotFound(error)) return { data: null };
      throw error;
    });
    const current = response.data || null;
    if (
      !current
      || current.status !== "sending"
      || trimText(current.reservationId) !== reservationId
    ) {
      return false;
    }
    await document.update({
      data: {
        status: "consumed",
        reservationId: "",
        consumedAt: db.serverDate(),
        lastDeliveryStatus: deliveryStatus,
        lastDeliveryError: trimText(deliveryErrorCode),
        lastDeliveryErrorCode: trimText(deliveryErrorCode),
        updatedAt: db.serverDate(),
      },
    });
    return true;
  });
}

async function sendReplyPushBestEffort({ inquiryId, customerOpenid }) {
  const config = getReplyPushConfiguration();
  if (!config.enabled) return "disabled";
  if (!trimText(customerOpenid)) return "no_recipient";
  try {
    const found = await findGrantedReplySubscription(
      inquiryId,
      customerOpenid,
      config.templateId
    );
    if (!found) return "no_grant";
    const subscription = await reserveReplySubscription(
      found,
      inquiryId,
      customerOpenid,
      config.templateId
    );
    if (!subscription) return "no_grant";

    let deliveryStatus = "success";
    let deliveryErrorCode = "";
    try {
      await cloud.openapi.subscribeMessage.send({
        touser: customerOpenid,
        templateId: config.templateId,
        page: `pages/my-inquiries/detail?id=${encodeURIComponent(inquiryId)}`,
        miniprogramState: config.miniprogramState,
        lang: "zh_CN",
        data: config.data,
      });
    } catch (error) {
      deliveryStatus = "failed";
      deliveryErrorCode = normalizeSafeErrorCode(error);
      console.warn("failed to send inquiry reply subscription message", {
        code: deliveryErrorCode,
      });
    }
    await completeReplySubscription(
      getDocumentId(subscription),
      trimText(subscription.reservationId),
      deliveryStatus,
      deliveryErrorCode
    );
    return deliveryStatus;
  } catch (error) {
    console.warn("inquiry reply push skipped after persistence", {
      code: normalizeSafeErrorCode(error),
    });
    return "failed";
  }
}

async function replyInquiry(event, openid) {
  const id = trimText(event.id);
  if (!id) return fail("INVALID_ID", "缺少需求 ID");
  if (hasForbiddenReplyTarget(event)) {
    return fail("FORBIDDEN_FIELD", "不允许由客户端指定回复接收人");
  }
  const reply = normalizeReplyContent(event.content);
  if (!reply.valid) return fail("INVALID_REPLY", reply.reason);
  const mutation = normalizeClientMutationId(event.clientMutationId);
  if (!mutation.valid) return fail("INVALID_MUTATION_ID", mutation.reason);

  const messageId = buildReplyMessageId(id, openid, mutation.value);
  const eventId = buildReplyEventId(messageId);
  const transactionResult = await db.runTransaction(async (transaction) => {
    const inquiryDocument = transaction.collection(INQUIRY_COLLECTION).doc(id);
    const inquiryResponse = await inquiryDocument.get().catch((error) => {
      if (isDocumentNotFound(error)) return { data: null };
      throw error;
    });
    const inquiry = inquiryResponse.data || null;
    if (!inquiry) return fail("NOT_FOUND", "需求不存在");

    const messageDocument = transaction.collection(MESSAGE_COLLECTION).doc(messageId);
    const existingMessageResponse = await messageDocument.get().catch((error) => {
      if (isDocumentNotFound(error)) return { data: null };
      throw error;
    });
    const existingMessage = existingMessageResponse.data || null;
    const previousClaimedBy = getClaimedBy(inquiry);
    if (existingMessage) {
      if (
        trimText(existingMessage.inquiryId) !== id
        || trimText(existingMessage.createdByOpenid) !== openid
        || trimText(existingMessage.content) !== reply.value
      ) {
        return fail(
          "IDEMPOTENCY_CONFLICT",
          "clientMutationId 已用于其他回复"
        );
      }
      if (previousClaimedBy && previousClaimedBy !== openid) {
        return fail("CLAIM_CONFLICT", "该需求已被其他管理员认领", {
          claim: buildClaimSummary(inquiry),
        });
      }
      return ok({
        id,
        message: buildReplyMessageResult({ ...existingMessage, _id: messageId }),
        status: normalizeStatus(inquiry.status),
        claim: buildClaimSummary(inquiry),
        idempotent: true,
      });
    }

    if (previousClaimedBy && previousClaimedBy !== openid) {
      return fail("CLAIM_CONFLICT", "该需求已被其他管理员认领", {
        claim: buildClaimSummary(inquiry),
      });
    }
    const customerOpenid = trimText(inquiry.openid);
    if (!customerOpenid) {
      return fail("MISSING_CUSTOMER", "需求缺少客户身份，无法回复");
    }

    const createdAt = db.serverDate();
    const previousStatus = normalizeStatus(inquiry.status);
    const nextStatus = previousStatus === "new" ? "contacted" : previousStatus;
    const nextClaim = previousClaimedBy || openid;
    const message = {
      id: messageId,
      inquiryId: id,
      customerOpenid,
      direction: "admin_to_customer",
      visibility: "customer",
      customerVisible: true,
      content: reply.value,
      createdAt,
      createdByOpenid: openid,
      clientMutationId: mutation.value,
    };
    await messageDocument.set({ data: message });

    const repliedAt = db.serverDate();
    const replyPreview = truncateText(reply.value, 80);
    const inquiryUpdate = {
      status: nextStatus,
      claimedByOpenid: nextClaim,
      claimedBy: nextClaim,
      repliedAt,
      lastReplyPreview: replyPreview,
      lastRepliedBy: openid,
      // Keep customer-facing readers compatible while the new naming rolls out.
      lastAdminReplyAt: repliedAt,
      lastAdminReplyPreview: replyPreview,
      customerUnreadCount: Math.max(
        0,
        Number(inquiry.customerUnreadCount || 0)
      ) + 1,
      replyCount: Math.max(0, Number(inquiry.replyCount || 0)) + 1,
      updatedAt: db.serverDate(),
      updatedByOpenid: openid,
    };
    if (!previousClaimedBy) inquiryUpdate.claimedAt = db.serverDate();
    if (!inquiry.firstReplyAt) inquiryUpdate.firstReplyAt = db.serverDate();
    await inquiryDocument.update({ data: inquiryUpdate });
    await writeAdminEvent(transaction, eventId, {
      inquiryId: id,
      type: "inquiry_replied",
      actorOpenid: openid,
      messageId,
      clientMutationId: mutation.value,
      before: { status: previousStatus, claimedBy: previousClaimedBy },
      after: { status: nextStatus, claimedBy: nextClaim },
    });
    return ok({
      id,
      message: buildReplyMessageResult({ ...message, _id: messageId }),
      status: nextStatus,
      claim: {
        claimedBy: nextClaim,
        claimedByOpenid: nextClaim,
        claimedAt: inquiry.claimedAt || inquiryUpdate.claimedAt || null,
      },
      customerOpenid,
      idempotent: false,
    });
  });

  if (!transactionResult.ok) return transactionResult;
  if (transactionResult.idempotent) {
    delete transactionResult.customerOpenid;
    return transactionResult;
  }
  transactionResult.cancelledAlertJobCount = await cancelInquiryAlertJobs(
    id,
    "replied"
  );
  transactionResult.pushStatus = await sendReplyPushBestEffort({
    inquiryId: id,
    customerOpenid: transactionResult.customerOpenid,
  });
  delete transactionResult.customerOpenid;
  return transactionResult;
}

async function correctContactType(event, openid) {
  const id = trimText(event.id);
  if (!id) return fail("INVALID_ID", "缺少需求 ID");
  const contactType = normalizeContactType(event.contactType);
  if (!contactType) {
    return fail("INVALID_CONTACT_TYPE", "联系方式类型只能为微信、电话或邮箱");
  }
  const eventId = createEventId("contact_type_corrected");

  return db.runTransaction(async (transaction) => {
    const document = transaction.collection(INQUIRY_COLLECTION).doc(id);
    const response = await document.get().catch((error) => {
      if (isDocumentNotFound(error)) return { data: null };
      throw error;
    });
    const current = response.data || null;
    if (!current) return fail("NOT_FOUND", "需求不存在");
    const previousContactType = trimText(current.contactType);
    const normalizedPreviousContactType = normalizeContactType(
      previousContactType
    );
    const previousContactTypeSource = trimText(current.contactTypeSource);
    if (
      normalizedPreviousContactType === contactType
      && previousContactTypeSource === "admin_corrected"
    ) {
      return ok({
        id,
        contactType,
        previousContactType,
        idempotent: true,
      });
    }

    await document.update({
      data: {
        contactType,
        contactTypeSource: "admin_corrected",
        contactTypeCorrectedAt: db.serverDate(),
        contactTypeCorrectedBy: openid,
        updatedAt: db.serverDate(),
        updatedByOpenid: openid,
      },
    });
    await writeAdminEvent(transaction, eventId, {
      inquiryId: id,
      type: "contact_type_corrected",
      actorOpenid: openid,
      before: {
        contactType: previousContactType,
        contactTypeSource: previousContactTypeSource,
      },
      after: {
        contactType,
        contactTypeSource: "admin_corrected",
      },
    });
    return ok({
      id,
      contactType,
      previousContactType,
      idempotent: false,
    });
  });
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const action = trimText(event.action);
  const admin = isAdmin(OPENID);
  const flags = getFeatureFlags();

  if (action === "checkAccess") return ok({ isAdmin: admin, ...flags });
  if (!admin) return fail("FORBIDDEN", "无权限查看需求管理");

  if (
    ["claimInquiry", "takeOverInquiry", "replyInquiry"].includes(action)
    && !flags.followupEnabled
  ) {
    return fail("FEATURE_DISABLED", "需求跟进功能尚未启用");
  }

  try {
    if (action === "listInquiries") return listInquiries(event, OPENID);
    if (action === "getInquiry") return getInquiry(event);
    if (action === "getInquirySummary") return getInquirySummary(event, OPENID);
    if (action === "updateInquiryStatus") return updateInquiryStatus(event, OPENID);
    if (action === "saveInquiryNote") return saveInquiryNote(event, OPENID);
    if (action === "claimInquiry") return claimInquiry(event, OPENID);
    if (action === "takeOverInquiry") return takeOverInquiry(event, OPENID);
    if (action === "replyInquiry") return replyInquiry(event, OPENID);
    if (action === "correctContactType") return correctContactType(event, OPENID);
    return fail("UNKNOWN_ACTION", "未知需求管理操作");
  } catch (error) {
    console.error("inquiryAdmin error", {
      action: /^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(action) ? action : "unknown",
      code: normalizeSafeErrorCode(error),
    });
    return fail("SERVER_ERROR", "需求管理服务异常，请稍后重试");
  }
};
