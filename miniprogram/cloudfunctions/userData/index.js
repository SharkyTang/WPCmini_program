const cloud = require("wx-server-sdk");
const {
  FEEDBACK_COLLECTION,
  INQUIRY_COLLECTION,
  INQUIRY_MESSAGE_COLLECTION,
  INQUIRY_REPLY_SUBSCRIPTION_COLLECTION,
  NOTIFICATION_SUBSCRIPTION_COLLECTION,
  NOTIFICATION_TYPE_KEYS,
  buildFeedbackRecord,
  buildInquiryRecord,
  buildInquiryReplySubscriptionId,
  buildTemplateConfig,
  isValidSubscriptionTemplateId,
  normalizeSubscriptionStatus,
  pickPreferenceRecord,
  validateSubscriptionGrant,
  validateUserProfileDraft,
  validateFeedbackDraft,
  validateInquiryDraft,
} = require("./userDataLogic");

const USER_PROFILE_COLLECTION = "user_profiles";
const CUSTOMER_INQUIRY_PAGE_SIZE = 20;
const CUSTOMER_INQUIRY_PAGE_SIZE_MAX = 50;
const CUSTOMER_MESSAGE_PAGE_SIZE = 50;
const CUSTOMER_MESSAGE_PAGE_SIZE_MAX = 100;
const UNREAD_SUMMARY_BATCH_SIZE = 100;
const ADMIN_PENDING_REPLY_BATCH_SIZE = 100;
const INQUIRY_NOTIFIER_RESPONSE_BUDGET_MS = 1000;
const INQUIRY_ALERT_RATE_LIMIT_MAX = 3;
const INQUIRY_ALERT_RATE_LIMIT_WINDOW_MINUTES = 10;
const INQUIRY_ALERT_SUPPRESSION_REASON = "submission_rate_limited";

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();
const _ = db.command;

function ok(data = {}) {
  return {
    ok: true,
    ...data,
  };
}

function fail(code, message) {
  return {
    ok: false,
    code,
    message,
  };
}

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseOpenidSet(value) {
  return new Set(
    trimText(value)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function resolveAdminRole(openid, roleEnvKey) {
  const roleValue = trimText(process.env[roleEnvKey]);
  const fallbackValue = trimText(process.env.ADMIN_OPENIDS);
  return parseOpenidSet(roleValue || fallbackValue).has(openid);
}

function getRequestContext(event, openid) {
  return {
    source: event.source,
    sourcePage: event.sourcePage,
    route: event.route,
    appVersion: event.appVersion,
    systemInfo: event.systemInfo,
    openid,
  };
}

function isFeatureEnabled(name) {
  return trimText(process.env[name]).toLowerCase() === "true";
}

function parseReplyTemplateFieldEntries(rawValue) {
  const sourceText = typeof rawValue === "string" ? rawValue : "";
  const raw = sourceText.trim();
  if (!raw) return null;

  let entries;
  if (raw.startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    entries = Object.entries(parsed);

    // JSON.parse keeps only the final value for a duplicate key. Count the
    // allowed flat keys in the source as well so duplicate semantic names are
    // rejected instead of being silently overwritten.
    const sourceSemanticNames = [];
    const semanticKeyPattern = /"(title|content|remark|time)"\s*:/g;
    let match;
    while ((match = semanticKeyPattern.exec(raw))) {
      sourceSemanticNames.push(match[1]);
    }
    if (
      sourceSemanticNames.length !== entries.length
      || new Set(sourceSemanticNames).size !== sourceSemanticNames.length
    ) {
      return null;
    }
  } else {
    if (/[\r\n]/.test(sourceText)) return null;
    const parts = raw.split(",");
    if (!parts.length || parts.some((part) => !trimText(part))) return null;
    entries = [];
    for (const part of parts) {
      const separatorIndex = part.indexOf("=");
      if (
        separatorIndex <= 0
        || separatorIndex !== part.lastIndexOf("=")
        || separatorIndex >= part.length - 1
      ) {
        return null;
      }
      entries.push([
        trimText(part.slice(0, separatorIndex)),
        trimText(part.slice(separatorIndex + 1)),
      ]);
    }
  }

  if (!entries.length) return null;
  const allowedSemanticNames = new Set(["title", "content", "remark", "time"]);
  const semanticNames = new Set();
  const fieldNames = new Set();
  const normalizedEntries = [];
  for (const [semanticName, templateField] of entries) {
    const normalizedSemanticName = trimText(semanticName);
    const normalizedFieldName = trimText(templateField);
    if (
      !allowedSemanticNames.has(normalizedSemanticName)
      || semanticNames.has(normalizedSemanticName)
      || fieldNames.has(normalizedFieldName)
      || !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(normalizedFieldName)
    ) {
      return null;
    }
    semanticNames.add(normalizedSemanticName);
    fieldNames.add(normalizedFieldName);
    normalizedEntries.push([normalizedSemanticName, normalizedFieldName]);
  }
  return normalizedEntries;
}

function parseReplyTemplateFields(rawValue) {
  const entries = parseReplyTemplateFieldEntries(rawValue);
  return {
    valid: Boolean(entries),
    fieldNames: entries ? entries.map(([, fieldName]) => fieldName) : [],
  };
}

function hasValidReplyTemplateFields(rawValue) {
  return parseReplyTemplateFields(rawValue).valid;
}

function normalizeSafeErrorCode(error, fallback = "SERVER_ERROR") {
  const rawValue = error && (error.errCode || error.code);
  const rawCode = typeof rawValue === "number"
    ? String(rawValue)
    : trimText(rawValue);
  const normalized = rawCode
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "_")
    .slice(0, 48);
  return normalized || fallback;
}

function getInquiryReplyTemplateConfig() {
  const templateId = trimText(process.env.INQUIRY_REPLY_TEMPLATE_ID);
  return {
    enabled: isFeatureEnabled("INQUIRY_FOLLOWUP_ENABLED")
      && isFeatureEnabled("INQUIRY_CUSTOMER_PUSH_ENABLED")
      && isValidSubscriptionTemplateId(templateId)
      && hasValidReplyTemplateFields(
        process.env.INQUIRY_REPLY_TEMPLATE_FIELDS
      ),
    templateId,
  };
}

async function kickInquiryNotifier(inquiryId) {
  if (
    !isFeatureEnabled("INQUIRY_FOLLOWUP_ENABLED")
    || !isFeatureEnabled("INQUIRY_EMAIL_ALERTS_ENABLED")
  ) {
    return { status: "disabled" };
  }
  if (typeof cloud.callFunction !== "function") {
    return { status: "unavailable" };
  }
  const internalToken = trimText(process.env.INQUIRY_NOTIFIER_INTERNAL_TOKEN);
  if (!internalToken) {
    return { status: "unavailable" };
  }
  const configuredBudget = Number(process.env.INQUIRY_NOTIFIER_RESPONSE_BUDGET_MS);
  const responseBudget = Number.isFinite(configuredBudget)
    && configuredBudget >= 10
    && configuredBudget <= 5000
    ? configuredBudget
    : INQUIRY_NOTIFIER_RESPONSE_BUDGET_MS;
  let timeoutId;
  const invocation = Promise.resolve()
    .then(() => cloud.callFunction({
      name: "inquiryNotifier",
      data: {
        action: "kick",
        inquiryId,
        internalToken,
      },
    }))
    .then((response) => {
      const result = (response && response.result) || {};
      return {
        status: trimText(result.status) || (result.ok === false ? "failed" : "queued"),
      };
    })
    .catch((error) => {
      // The inquiry is already durable. Do not log the event or SMTP response:
      // either may contain private metadata. The timer scan will reconcile it.
      console.error("inquiry notifier kick failed", {
        code: normalizeSafeErrorCode(error, "INVOKE_FAILED"),
      });
      return { status: "deferred" };
    });
  const budget = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve({ status: "deferred" }), responseBudget);
  });
  const result = await Promise.race([invocation, budget]);
  if (timeoutId) clearTimeout(timeoutId);
  return result;
}

function normalizePageSize(value) {
  const pageSize = Number(value);
  if (!Number.isInteger(pageSize) || pageSize <= 0) return CUSTOMER_INQUIRY_PAGE_SIZE;
  return Math.min(pageSize, CUSTOMER_INQUIRY_PAGE_SIZE_MAX);
}

function normalizeMessagePageSize(value) {
  const pageSize = Number(value);
  if (!Number.isInteger(pageSize) || pageSize <= 0) return CUSTOMER_MESSAGE_PAGE_SIZE;
  return Math.min(pageSize, CUSTOMER_MESSAGE_PAGE_SIZE_MAX);
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

function compareIds(left, right) {
  const leftId = trimText(left);
  const rightId = trimText(right);
  if (leftId === rightId) return 0;
  return leftId < rightId ? -1 : 1;
}

function sortByCreatedAtAndId(items, direction) {
  const multiplier = direction === "desc" ? -1 : 1;
  return items.sort((left, right) => {
    const timeDifference = toTimestamp(left.createdAt) - toTimestamp(right.createdAt);
    if (timeDifference) return timeDifference * multiplier;
    return compareIds(left._id || left.id, right._id || right.id) * multiplier;
  });
}

function dedupeById(items) {
  const seen = new Set();
  return items.filter((item) => {
    const id = trimText(item && (item._id || item.id));
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function encodeCursor(data) {
  return JSON.stringify({ v: 1, ...data });
}

function parseInquiryCursor(value) {
  const text = trimText(value);
  if (!text) return { valid: true, cursor: null };
  if (/^\d+$/.test(text)) {
    const timestamp = Number(text);
    return Number.isFinite(timestamp) && timestamp > 0
      ? { valid: true, cursor: { timestamp, id: "", legacy: true } }
      : { valid: false, cursor: null };
  }
  if (text.length > 512) return { valid: false, cursor: null };
  try {
    const parsed = JSON.parse(text);
    const timestamp = Number(parsed && parsed.t);
    const id = trimText(parsed && parsed.id);
    if (
      !parsed
      || parsed.v !== 1
      || parsed.k !== "inquiry"
      || !Number.isFinite(timestamp)
      || timestamp <= 0
      || !id
      || id.length > 128
    ) {
      return { valid: false, cursor: null };
    }
    return { valid: true, cursor: { timestamp, id, legacy: false } };
  } catch (error) {
    return { valid: false, cursor: null };
  }
}

function parseMessageCursor(value, inquiryId) {
  const text = trimText(value);
  if (!text) return { valid: true, cursor: null };
  if (text.length > 768) return { valid: false, cursor: null };
  try {
    const parsed = JSON.parse(text);
    const timestamp = Number(parsed && parsed.t);
    const id = trimText(parsed && parsed.id);
    const snapshotReplyCount = Number(parsed && parsed.s);
    const seenCount = Number(parsed && parsed.n);
    if (
      !parsed
      || parsed.v !== 1
      || parsed.k !== "message"
      || trimText(parsed.i) !== inquiryId
      || !Number.isFinite(timestamp)
      || timestamp <= 0
      || !id
      || id.length > 128
      || !Number.isInteger(snapshotReplyCount)
      || snapshotReplyCount < 0
      || !Number.isInteger(seenCount)
      || seenCount < 0
    ) {
      return { valid: false, cursor: null };
    }
    return {
      valid: true,
      cursor: {
        timestamp,
        id,
        snapshotReplyCount,
        seenCount,
      },
    };
  } catch (error) {
    return { valid: false, cursor: null };
  }
}

function parseSeenThroughToken(value, inquiryId) {
  const text = trimText(value);
  if (!text || text.length > 768) return null;
  try {
    const parsed = JSON.parse(text);
    const replyCount = Number(parsed && parsed.r);
    const messageId = trimText(parsed && parsed.m);
    if (
      !parsed
      || parsed.v !== 1
      || parsed.k !== "read"
      || trimText(parsed.i) !== inquiryId
      || !Number.isInteger(replyCount)
      || replyCount < 0
      || (replyCount > 0 && !messageId)
      || messageId.length > 128
    ) {
      return null;
    }
    return { replyCount, messageId };
  } catch (error) {
    return null;
  }
}

function getReplyCountSnapshot(inquiry = {}) {
  return Math.max(
    0,
    Number(inquiry.replyCount) || 0,
    Number(inquiry.customerUnreadCount) || 0
  );
}

function toCustomerInquiry(item = {}) {
  return {
    id: trimText(item._id || item.id),
    source: trimText(item.source),
    caseDocId: trimText(item.caseDocId),
    caseId: trimText(item.caseId),
    caseTitle: trimText(item.caseTitle),
    wineType: trimText(item.wineType),
    packageTypes: Array.isArray(item.packageTypes) ? item.packageTypes : [],
    styles: Array.isArray(item.styles) ? item.styles : [],
    priceLevel: trimText(item.priceLevel),
    scenes: Array.isArray(item.scenes) ? item.scenes : [],
    content: trimText(item.content),
    contact: trimText(item.contact),
    contactType: trimText(item.contactType),
    status: trimText(item.status) || "new",
    createdAt: item.createdAt || "",
    updatedAt: item.updatedAt || "",
    lastAdminReplyAt: item.lastAdminReplyAt || "",
    lastAdminReplyPreview: trimText(item.lastAdminReplyPreview),
    customerUnreadCount: Math.max(0, Number(item.customerUnreadCount) || 0),
  };
}

function toCustomerMessage(item = {}) {
  return {
    id: trimText(item._id || item.id),
    inquiryId: trimText(item.inquiryId),
    content: trimText(item.content),
    createdAt: item.createdAt || "",
    readAt: item.readAt || "",
  };
}

async function getOwnedInquiry(id, openid) {
  const inquiryId = trimText(id);
  if (!inquiryId) return null;
  try {
    const response = await db.collection(INQUIRY_COLLECTION).doc(inquiryId).get();
    const item = response.data || null;
    return item && trimText(item.openid) === openid ? item : null;
  } catch (error) {
    return null;
  }
}

function readBoundedIntegerEnv(name, fallback, minimum, maximum) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function getInquiryAlertRateLimit() {
  return {
    maximum: readBoundedIntegerEnv(
      "INQUIRY_ALERT_RATE_LIMIT_MAX",
      INQUIRY_ALERT_RATE_LIMIT_MAX,
      1,
      20
    ),
    windowMinutes: readBoundedIntegerEnv(
      "INQUIRY_ALERT_RATE_LIMIT_WINDOW_MINUTES",
      INQUIRY_ALERT_RATE_LIMIT_WINDOW_MINUTES,
      1,
      60
    ),
  };
}

async function getInquiryAlertSuppression(openid) {
  const rateLimit = getInquiryAlertRateLimit();
  if (!openid || typeof _.gte !== "function") {
    return { suppressed: false, reason: "" };
  }
  const cutoff = new Date(Date.now() - rateLimit.windowMinutes * 60 * 1000);
  try {
    const response = await db
      .collection(INQUIRY_COLLECTION)
      .where({
        openid,
        createdAt: _.gte(cutoff),
      })
      .count();
    return {
      suppressed: Math.max(0, Number(response.total) || 0) >= rateLimit.maximum,
      reason: INQUIRY_ALERT_SUPPRESSION_REASON,
    };
  } catch (error) {
    // Rate-limit checks must never reject a valid customer inquiry. Log only a
    // normalized code; the server OPENID and raw database error stay private.
    console.warn("inquiry alert rate check failed", {
      code: normalizeSafeErrorCode(error, "RATE_CHECK_FAILED"),
    });
    return { suppressed: false, reason: "" };
  }
}

async function submitInquiry(event, openid) {
  const input = event.inquiry || event.data || {};
  const validation = validateInquiryDraft(input);
  if (!validation.valid) return fail(validation.code, validation.message);

  const suppression = await getInquiryAlertSuppression(openid);
  const record = buildInquiryRecord(validation.data, getRequestContext(event, openid));
  const response = await db.collection(INQUIRY_COLLECTION).add({
    data: {
      ...record,
      ...(suppression.suppressed
        ? {
          alertTaskStatus: "suppressed",
          alertTaskStopReason: suppression.reason,
          alertTaskUpdatedAt: db.serverDate(),
          alertSuppressedAt: db.serverDate(),
        }
        : {}),
      createdAt: db.serverDate(),
    },
  });
  const inquiryId = response._id || "";
  const alert = inquiryId && !suppression.suppressed
    ? await kickInquiryNotifier(inquiryId)
    : { status: suppression.suppressed ? "suppressed" : "deferred" };

  return ok({
    id: inquiryId,
    alertStatus: alert.status,
    replySubscription: getInquiryReplyTemplateConfig(),
  });
}

async function sumUnreadAcrossOwnedInquiries(openid) {
  let unreadCount = 0;
  let cursorId = "";
  while (true) {
    const condition = { openid };
    if (cursorId) condition._id = _.gt(cursorId);
    const response = await db
      .collection(INQUIRY_COLLECTION)
      .where(condition)
      .orderBy("_id", "asc")
      .limit(UNREAD_SUMMARY_BATCH_SIZE)
      .get();
    const items = response.data || [];
    unreadCount += items.reduce(
      (total, item) => total + Math.max(0, Number(item.customerUnreadCount) || 0),
      0
    );
    if (items.length < UNREAD_SUMMARY_BATCH_SIZE) break;
    const lastId = trimText(items[items.length - 1] && items[items.length - 1]._id);
    if (!lastId || lastId === cursorId) break;
    cursorId = lastId;
  }
  return unreadCount;
}

async function countAdminPendingReplyInquiries() {
  let pendingReplyCount = 0;
  let cursorId = "";
  while (true) {
    const condition = cursorId ? { _id: _.gt(cursorId) } : null;
    let query = db.collection(INQUIRY_COLLECTION);
    if (condition) query = query.where(condition);
    query = query
      .orderBy("_id", "asc")
      .limit(ADMIN_PENDING_REPLY_BATCH_SIZE);
    if (typeof query.field === "function") {
      query = query.field({ _id: true, status: true, replyCount: true });
    }
    const response = await query.get();
    const items = response.data || [];
    pendingReplyCount += items.reduce((total, item) => {
      const status = trimText(item.status) || "new";
      const hasCustomerVisibleReply = Math.max(0, Number(item.replyCount) || 0) > 0;
      return total + (
        status !== "done"
        && status !== "invalid"
        && !hasCustomerVisibleReply
          ? 1
          : 0
      );
    }, 0);
    if (items.length < ADMIN_PENDING_REPLY_BATCH_SIZE) break;
    const lastId = trimText(items[items.length - 1] && items[items.length - 1]._id);
    if (!lastId || lastId === cursorId) break;
    cursorId = lastId;
  }
  return pendingReplyCount;
}

async function getMyInquirySummary(openid) {
  const query = db.collection(INQUIRY_COLLECTION).where({ openid });
  const [countResponse, unreadCount] = await Promise.all([
    typeof query.count === "function" ? query.count() : Promise.resolve({ total: 0 }),
    sumUnreadAcrossOwnedInquiries(openid),
  ]);
  return ok({
    inquiryCount: Math.max(0, Number(countResponse.total) || 0),
    unreadCount,
    replySubscription: getInquiryReplyTemplateConfig(),
  });
}

async function getInquiryBadgeSummary(openid) {
  const inquiryAdmin = resolveAdminRole(openid, "INQUIRY_ADMIN_OPENIDS");
  const [myUnreadCount, adminPendingReplyCount] = await Promise.all([
    sumUnreadAcrossOwnedInquiries(openid),
    inquiryAdmin ? countAdminPendingReplyInquiries() : Promise.resolve(0),
  ]);
  const normalizedAdminCount = inquiryAdmin
    ? Math.max(0, Number(adminPendingReplyCount) || 0)
    : 0;
  return ok({
    myUnreadCount,
    // Keep the established key for old profile pages; its meaning is now
    // "active inquiries still awaiting the first customer-visible reply".
    adminNewCount: normalizedAdminCount,
    adminPendingReplyCount: normalizedAdminCount,
  });
}

async function listMyInquiries(event, openid) {
  const pageSize = normalizePageSize(event.pageSize);
  const parsedCursor = parseInquiryCursor(event.cursor);
  if (!parsedCursor.valid) return fail("INVALID_CURSOR", "需求列表游标无效");

  let rows;
  if (!parsedCursor.cursor) {
    const response = await db
      .collection(INQUIRY_COLLECTION)
      .where({ openid })
      .orderBy("createdAt", "desc")
      .orderBy("_id", "desc")
      .limit(pageSize + 1)
      .get();
    rows = response.data || [];
  } else {
    const { timestamp, id, legacy } = parsedCursor.cursor;
    const olderPromise = db
      .collection(INQUIRY_COLLECTION)
      .where({ openid, createdAt: _.lt(new Date(timestamp)) })
      .orderBy("createdAt", "desc")
      .orderBy("_id", "desc")
      .limit(pageSize + 1)
      .get();
    const sameTimePromise = legacy
      ? Promise.resolve({ data: [] })
      : db
        .collection(INQUIRY_COLLECTION)
        .where({
          openid,
          createdAt: new Date(timestamp),
          _id: _.lt(id),
        })
        .orderBy("_id", "desc")
        .limit(pageSize + 1)
        .get();
    const [sameTimeResponse, olderResponse] = await Promise.all([
      sameTimePromise,
      olderPromise,
    ]);
    rows = sortByCreatedAtAndId(
      dedupeById([
        ...(sameTimeResponse.data || []),
        ...(olderResponse.data || []),
      ]),
      "desc"
    );
  }

  const hasMore = rows.length > pageSize;
  const visibleRows = rows.slice(0, pageSize);
  const items = visibleRows.map(toCustomerInquiry);
  const lastItem = visibleRows[visibleRows.length - 1];
  const lastTimestamp = toTimestamp(lastItem && lastItem.createdAt);
  const lastId = trimText(lastItem && (lastItem._id || lastItem.id));
  const nextCursor = hasMore && lastTimestamp && lastId
    ? encodeCursor({ k: "inquiry", t: lastTimestamp, id: lastId })
    : "";
  return ok({
    items,
    nextCursor,
    hasMore: Boolean(nextCursor),
  });
}

async function getMyInquiryDetail(event, openid) {
  const inquiry = await getOwnedInquiry(event.id || event.inquiryId, openid);
  if (!inquiry) return fail("INQUIRY_NOT_FOUND", "需求不存在或无权查看");
  const inquiryId = trimText(inquiry._id || inquiry.id);
  const pageSize = normalizeMessagePageSize(event.messagePageSize || event.pageSize);
  const parsedCursor = parseMessageCursor(event.messageCursor, inquiryId);
  if (!parsedCursor.valid) {
    return fail("INVALID_MESSAGE_CURSOR", "回复记录游标无效");
  }

  const exactVisibility = {
    inquiryId,
    customerVisible: true,
    direction: "admin_to_customer",
  };
  let rows;
  let snapshotReplyCount;
  let priorSeenCount;
  if (!parsedCursor.cursor) {
    snapshotReplyCount = getReplyCountSnapshot(inquiry);
    priorSeenCount = 0;
    const response = await db
      .collection(INQUIRY_MESSAGE_COLLECTION)
      .where(exactVisibility)
      .orderBy("createdAt", "asc")
      .orderBy("_id", "asc")
      .limit(pageSize + 1)
      .get();
    rows = response.data || [];
  } else {
    const cursor = parsedCursor.cursor;
    snapshotReplyCount = cursor.snapshotReplyCount;
    priorSeenCount = cursor.seenCount;
    const laterPromise = db
      .collection(INQUIRY_MESSAGE_COLLECTION)
      .where({
        ...exactVisibility,
        createdAt: _.gt(new Date(cursor.timestamp)),
      })
      .orderBy("createdAt", "asc")
      .orderBy("_id", "asc")
      .limit(pageSize + 1)
      .get();
    const sameTimePromise = db
      .collection(INQUIRY_MESSAGE_COLLECTION)
      .where({
        ...exactVisibility,
        createdAt: new Date(cursor.timestamp),
        _id: _.gt(cursor.id),
      })
      .orderBy("_id", "asc")
      .limit(pageSize + 1)
      .get();
    const [sameTimeResponse, laterResponse] = await Promise.all([
      sameTimePromise,
      laterPromise,
    ]);
    rows = sortByCreatedAtAndId(
      dedupeById([
        ...(sameTimeResponse.data || []),
        ...(laterResponse.data || []),
      ]),
      "asc"
    );
  }

  const hasMoreMessages = rows.length > pageSize;
  const visibleRows = rows.slice(0, pageSize);
  const seenCount = priorSeenCount + visibleRows.length;
  const lastMessage = visibleRows[visibleRows.length - 1];
  const lastMessageId = trimText(lastMessage && (lastMessage._id || lastMessage.id));
  const lastMessageTimestamp = toTimestamp(lastMessage && lastMessage.createdAt);
  const nextMessageCursor = hasMoreMessages && lastMessageId && lastMessageTimestamp
    ? encodeCursor({
      k: "message",
      i: inquiryId,
      t: lastMessageTimestamp,
      id: lastMessageId,
      s: snapshotReplyCount,
      n: seenCount,
    })
    : "";
  const seenThroughReplyCount = Math.min(snapshotReplyCount, seenCount);
  const seenThroughToken = !hasMoreMessages
    ? encodeCursor({
      k: "read",
      i: inquiryId,
      r: seenThroughReplyCount,
      m: lastMessageId,
    })
    : "";
  return ok({
    item: toCustomerInquiry(inquiry),
    messages: visibleRows.map(toCustomerMessage),
    nextMessageCursor,
    hasMoreMessages: Boolean(nextMessageCursor),
    seenThroughToken,
    seenThroughReplyCount,
    replySubscription: getInquiryReplyTemplateConfig(),
  });
}

async function markInquiryMessagesRead(event, openid) {
  const inquiryId = trimText(event.id || event.inquiryId);
  if (!inquiryId) return fail("INQUIRY_NOT_FOUND", "需求不存在或无权查看");
  const token = parseSeenThroughToken(event.seenThroughToken, inquiryId);
  if (!token) return fail("INVALID_READ_TOKEN", "已读回执无效，请重新打开详情");

  return db.runTransaction(async (transaction) => {
    let inquiry;
    try {
      const response = await transaction
        .collection(INQUIRY_COLLECTION)
        .doc(inquiryId)
        .get();
      inquiry = response.data || null;
    } catch (error) {
      return fail("INQUIRY_NOT_FOUND", "需求不存在或无权查看");
    }
    if (!inquiry || trimText(inquiry.openid) !== openid) {
      return fail("INQUIRY_NOT_FOUND", "需求不存在或无权查看");
    }

    const currentUnreadCount = Math.max(0, Number(inquiry.customerUnreadCount) || 0);
    const storedReadCount = Number(inquiry.customerLastReadReplyCount);
    let currentReplyCount = Math.max(
      0,
      Number(inquiry.replyCount) || 0,
      currentUnreadCount
    );
    let previousReadCount;
    if (Number.isInteger(storedReadCount) && storedReadCount >= 0) {
      currentReplyCount = Math.max(currentReplyCount, storedReadCount + currentUnreadCount);
      previousReadCount = Math.min(storedReadCount, currentReplyCount);
    } else {
      previousReadCount = Math.max(0, currentReplyCount - currentUnreadCount);
    }

    if (token.replyCount > previousReadCount) {
      let message;
      try {
        const response = await transaction
          .collection(INQUIRY_MESSAGE_COLLECTION)
          .doc(token.messageId)
          .get();
        message = response.data || null;
      } catch (error) {
        return fail("INVALID_READ_TOKEN", "已读回执无效，请重新打开详情");
      }
      if (
        !message
        || trimText(message.inquiryId) !== inquiryId
        || message.customerVisible !== true
        || trimText(message.direction) !== "admin_to_customer"
      ) {
        return fail("INVALID_READ_TOKEN", "已读回执无效，请重新打开详情");
      }
    }

    const seenThroughReplyCount = Math.min(
      currentReplyCount,
      Math.max(previousReadCount, token.replyCount)
    );
    const unreadCount = Math.max(0, currentReplyCount - seenThroughReplyCount);
    await transaction.collection(INQUIRY_COLLECTION).doc(inquiryId).update({
      data: {
        replyCount: currentReplyCount,
        customerUnreadCount: unreadCount,
        customerLastReadReplyCount: seenThroughReplyCount,
        customerLastReadAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });
    return ok({
      id: inquiryId,
      unreadCount,
      seenThroughReplyCount,
      replyCount: currentReplyCount,
    });
  });
}

async function findInquiryReplySubscription(inquiryId, openid) {
  const deterministicId = buildInquiryReplySubscriptionId(inquiryId, openid);
  try {
    const deterministic = await db
      .collection(INQUIRY_REPLY_SUBSCRIPTION_COLLECTION)
      .doc(deterministicId)
      .get();
    if (deterministic && deterministic.data) {
      return {
        ...deterministic.data,
        _id: deterministic.data._id || deterministicId,
      };
    }
  } catch (error) {
    // Older grants used generated document IDs. A missing deterministic ID is
    // expected until that customer grants again, so fall through to the legacy
    // inquiry + OPENID lookup.
  }
  const response = await db
    .collection(INQUIRY_REPLY_SUBSCRIPTION_COLLECTION)
    .where({ inquiryId, openid })
    .limit(1)
    .get();
  return (response.data || [])[0] || null;
}

async function saveInquiryReplySubscription(event, openid) {
  const inquiry = await getOwnedInquiry(event.id || event.inquiryId, openid);
  if (!inquiry) return fail("INQUIRY_NOT_FOUND", "需求不存在或无权操作");
  const config = getInquiryReplyTemplateConfig();
  const templateId = trimText(event.templateId);
  const status = normalizeSubscriptionStatus(trimText(event.status));
  if (!config.enabled || !templateId || templateId !== config.templateId) {
    return fail("INVALID_TEMPLATE_CONFIG", "需求回复模板尚未启用");
  }
  if (!status) return fail("INVALID_SUBSCRIPTION", "订阅状态无效");

  const inquiryId = inquiry._id || inquiry.id;
  const existing = await findInquiryReplySubscription(inquiryId, openid);
  const data = {
    inquiryId,
    openid,
    templateId,
    status,
    grantedAt: status === "granted" ? db.serverDate() : null,
    consumedAt: null,
    updatedAt: db.serverDate(),
  };
  if (existing && existing._id) {
    await db.collection(INQUIRY_REPLY_SUBSCRIPTION_COLLECTION).doc(existing._id).update({ data });
  } else {
    const subscriptionId = buildInquiryReplySubscriptionId(inquiryId, openid);
    await db.collection(INQUIRY_REPLY_SUBSCRIPTION_COLLECTION).doc(subscriptionId).set({
      data: {
        ...data,
        createdAt: db.serverDate(),
      },
    });
  }
  return ok({
    inquiryId,
    templateId,
    status,
  });
}

async function submitFeedback(event, openid) {
  const input = event.feedback || event.data || {};
  const validation = validateFeedbackDraft(input);
  if (!validation.valid) return fail(validation.code, validation.message);

  const record = buildFeedbackRecord(validation.data, getRequestContext(event, openid));
  const response = await db.collection(FEEDBACK_COLLECTION).add({
    data: {
      ...record,
      createdAt: db.serverDate(),
    },
  });

  return ok({
    id: response._id || "",
  });
}

function getSubscriptionTemplateIds() {
  return {
    version_update: trimText(process.env.VERSION_UPDATE_TEMPLATE_ID),
    product_new: trimText(process.env.PRODUCT_NEW_TEMPLATE_ID),
  };
}

function getWechatTemplateId(item = {}) {
  return trimText(
    item.priTmplId
    || item.pri_tmpl_id
    || item.templateId
    || item.template_id
  );
}

function getWechatTemplateItems(response = {}) {
  const nestedData = response.data && typeof response.data === "object"
    ? response.data
    : {};
  const candidates = [
    response.data,
    nestedData.priTmplList,
    nestedData.templateList,
    nestedData.list,
    response.priTmplList,
    response.templateList,
    response.list,
  ];
  return candidates.find(Array.isArray) || [];
}

function getTemplateFieldNames(item = {}) {
  const fieldNames = new Set();
  const fieldNamePattern = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
  const templateFieldKeyPattern = /^(?:thing|character_string|number|letter|symbol|time|date|amount|phone_number|car_number|phrase)\d+$/i;
  const tokenPattern = /\{\{\s*([A-Za-z][A-Za-z0-9_]{0,31})\.DATA\s*\}\}/g;
  const collectTokens = (value) => {
    if (typeof value !== "string") return;
    let match;
    while ((match = tokenPattern.exec(value))) fieldNames.add(match[1]);
    tokenPattern.lastIndex = 0;
  };
  collectTokens(item.content);
  collectTokens(item.example);

  const explicitFieldKeys = new Set([
    "code",
    "field",
    "fieldName",
    "field_name",
    "key",
    "keyword",
    "keywordCode",
    "keyword_code",
    "name",
  ]);
  const visitDefinition = (value, depth = 0) => {
    if (!value || depth > 4) return;
    if (Array.isArray(value)) {
      value.forEach((entry) => visitDefinition(entry, depth + 1));
      return;
    }
    if (typeof value !== "object") return;
    Object.entries(value).forEach(([key, entry]) => {
      if (templateFieldKeyPattern.test(key)) fieldNames.add(key);
      if (
        explicitFieldKeys.has(key)
        && typeof entry === "string"
        && fieldNamePattern.test(trimText(entry))
      ) {
        fieldNames.add(trimText(entry));
      }
      if (typeof entry === "string") collectTokens(entry);
      else visitDefinition(entry, depth + 1);
    });
  };
  [
    item.fields,
    item.fieldList,
    item.field_list,
    item.keywords,
    item.keywordList,
    item.keyword_list,
  ].forEach((definition) => visitDefinition(definition));
  return fieldNames;
}

function buildInquiryReplyTemplateConfig() {
  const templateId = trimText(process.env.INQUIRY_REPLY_TEMPLATE_ID);
  const parsedFields = parseReplyTemplateFields(
    process.env.INQUIRY_REPLY_TEMPLATE_FIELDS
  );
  const idValid = isValidSubscriptionTemplateId(templateId);
  const valid = idValid && parsedFields.valid;
  return {
    type: "inquiry_reply",
    envKey: "INQUIRY_REPLY_TEMPLATE_ID",
    fieldsEnvKey: "INQUIRY_REPLY_TEMPLATE_FIELDS",
    templateId,
    valid,
    configuredFieldCount: parsedFields.fieldNames.length,
    code: valid ? "" : "INVALID_TEMPLATE_CONFIG",
    message: valid
      ? ""
      : "需求回复模板配置错误，请填写当前 AppID 的长模板 ID 和不重复的字段映射",
    fieldNames: parsedFields.fieldNames,
  };
}

function verifyInquiryReplyTemplate(config, templateMap) {
  const item = templateMap[config.templateId] || null;
  const availableFieldNames = item ? getTemplateFieldNames(item) : new Set();
  const matchedFieldCount = config.fieldNames.reduce(
    (count, fieldName) => count + (availableFieldNames.has(fieldName) ? 1 : 0),
    0
  );
  const fieldsMatch = config.valid
    && matchedFieldCount === config.fieldNames.length;
  const code = !config.valid
    ? config.code
    : !item
      ? "TEMPLATE_NOT_IN_CURRENT_APP"
      : !fieldsMatch
        ? "TEMPLATE_FIELDS_MISMATCH"
        : "";
  const message = !config.valid
    ? config.message
    : !item
      ? "INQUIRY_REPLY_TEMPLATE_ID 对应模板不在当前 AppID 的“我的模板”列表中"
      : !fieldsMatch
        ? "INQUIRY_REPLY_TEMPLATE_FIELDS 与当前 AppID 模板字段不一致"
        : "";
  return {
    type: config.type,
    envKey: config.envKey,
    fieldsEnvKey: config.fieldsEnvKey,
    templateId: config.templateId,
    valid: config.valid,
    configuredFieldCount: config.configuredFieldCount,
    matchedFieldCount,
    missingFieldCount: Math.max(0, config.configuredFieldCount - matchedFieldCount),
    existsInCurrentApp: Boolean(item),
    fieldsMatch,
    usable: config.valid && Boolean(item) && fieldsMatch,
    title: item ? trimText(item.title) : "",
    templateType: item ? item.type : "",
    code,
    message,
  };
}

async function verifySubscriptionTemplates(appid) {
  const templateIds = getSubscriptionTemplateIds();
  const templateConfigs = NOTIFICATION_TYPE_KEYS.reduce((result, type) => {
    result[type] = buildTemplateConfig(type, templateIds[type]);
    return result;
  }, {});
  const inquiryReplyTemplateConfig = buildInquiryReplyTemplateConfig();
  templateConfigs.inquiry_reply = {
    type: inquiryReplyTemplateConfig.type,
    envKey: inquiryReplyTemplateConfig.envKey,
    fieldsEnvKey: inquiryReplyTemplateConfig.fieldsEnvKey,
    templateId: inquiryReplyTemplateConfig.templateId,
    valid: inquiryReplyTemplateConfig.valid,
    configuredFieldCount: inquiryReplyTemplateConfig.configuredFieldCount,
    code: inquiryReplyTemplateConfig.code,
    message: inquiryReplyTemplateConfig.message,
  };

  if (
    !cloud.openapi
    || !cloud.openapi.subscribeMessage
    || typeof cloud.openapi.subscribeMessage.getTemplateList !== "function"
  ) {
    return ok({
      appid,
      verificationAvailable: false,
      verificationCode: "OPENAPI_UNAVAILABLE",
      verificationMessage: "当前 userData 云函数 SDK 不支持查询订阅模板列表，请重新部署云函数依赖",
      templates: templateConfigs,
    });
  }

  try {
    const response = await cloud.openapi.subscribeMessage.getTemplateList({});
    const templateItems = getWechatTemplateItems(response);
    const templateMap = templateItems.reduce((result, item) => {
      const id = getWechatTemplateId(item);
      if (id) result[id] = item;
      return result;
    }, {});
    const templates = NOTIFICATION_TYPE_KEYS.reduce((result, type) => {
      const config = templateConfigs[type];
      const item = templateMap[config.templateId] || null;
      result[type] = {
        ...config,
        existsInCurrentApp: Boolean(item),
        usable: config.valid && Boolean(item),
        title: item ? trimText(item.title) : "",
        templateType: item ? item.type : "",
        code: !config.valid
          ? config.code
          : item
            ? ""
            : "TEMPLATE_NOT_IN_CURRENT_APP",
        message: !config.valid
          ? config.message
          : item
            ? ""
            : `${config.envKey} 对应模板不在当前 AppID 的“我的模板”列表中`,
      };
      return result;
    }, {});
    templates.inquiry_reply = verifyInquiryReplyTemplate(
      inquiryReplyTemplateConfig,
      templateMap
    );
    return ok({
      appid,
      verificationAvailable: true,
      templateCount: templateItems.length,
      templates,
    });
  } catch (error) {
    const verificationCode = normalizeSafeErrorCode(error, "OPENAPI_ERROR");
    console.error("subscription template verification error", {
      appid,
      code: verificationCode,
    });
    return ok({
      appid,
      verificationAvailable: false,
      verificationCode,
      verificationMessage: "微信模板列表查询失败，请稍后重试",
      templates: templateConfigs,
    });
  }
}

async function findSubscription(openid, type) {
  const response = await db
    .collection(NOTIFICATION_SUBSCRIPTION_COLLECTION)
    .where({ openid, type })
    .limit(1)
    .get();
  return pickPreferenceRecord(response.data);
}

async function fetchSubscriptionStatus(openid) {
  const templateIds = getSubscriptionTemplateIds();
  const templateConfigs = NOTIFICATION_TYPE_KEYS.reduce((result, type) => {
    result[type] = buildTemplateConfig(type, templateIds[type]);
    return result;
  }, {});
  const response = await db
    .collection(NOTIFICATION_SUBSCRIPTION_COLLECTION)
    .where({ openid })
    .limit(NOTIFICATION_TYPE_KEYS.length)
    .get();
  const subscriptions = (response.data || []).reduce((result, item) => {
    const currentTemplateId = templateIds[item.type] || "";
    const matchesCurrentTemplate = (
      templateConfigs[item.type]
      && templateConfigs[item.type].valid
      && item.templateId === currentTemplateId
    );
    result[item.type] = {
      templateId: matchesCurrentTemplate ? item.templateId || "" : currentTemplateId,
      status: matchesCurrentTemplate ? item.status || "idle" : "idle",
    };
    return result;
  }, {});
  return ok({
    subscriptions,
    templateIds,
    templateConfigs,
  });
}

async function saveSubscriptionGrant(event, openid) {
  const templateIds = getSubscriptionTemplateIds();
  const validation = validateSubscriptionGrant(event, templateIds);
  if (!validation.valid) return fail(validation.code, validation.message);

  const { type, templateId, status } = validation.data;
  const subscription = await findSubscription(openid, type);
  const data = {
    openid,
    type,
    templateId,
    status,
    grantedAt: status === "granted" ? db.serverDate() : null,
    consumedAt: null,
    updatedAt: db.serverDate(),
  };

  if (subscription && (subscription._id || subscription.id)) {
    const subscriptionId = subscription._id || subscription.id;
    await db.collection(NOTIFICATION_SUBSCRIPTION_COLLECTION).doc(subscriptionId).update({
      data,
    });
  } else {
    await db.collection(NOTIFICATION_SUBSCRIPTION_COLLECTION).add({
      data: {
        ...data,
        createdAt: db.serverDate(),
      },
    });
  }
  return fetchSubscriptionStatus(openid);
}

function toProfileResponse(profile) {
  if (!profile) return null;
  return {
    nickname: trimText(profile.nickname),
    avatarFileId: trimText(profile.avatarFileId),
  };
}

async function findUserProfile(openid) {
  const response = await db
    .collection(USER_PROFILE_COLLECTION)
    .where({ openid })
    .limit(1)
    .get();
  return (response.data || [])[0] || null;
}

async function getUserProfile(openid) {
  const profile = await findUserProfile(openid);
  return ok({
    profile: toProfileResponse(profile),
  });
}

async function getAvatarUrl(avatarFileId) {
  if (!avatarFileId || avatarFileId.indexOf("cloud://") !== 0) return "";
  try {
    const response = await cloud.getTempFileURL({
      fileList: [avatarFileId],
    });
    const item = response && response.fileList && response.fileList[0];
    return (item && item.tempFileURL) || "";
  } catch (error) {
    console.warn("profile avatar url resolve failed", error);
    return "";
  }
}

async function getSessionSummary(openid) {
  const profileRecord = await findUserProfile(openid);
  const profile = toProfileResponse(profileRecord);
  const avatarUrl = profile ? await getAvatarUrl(profile.avatarFileId) : "";
  return ok({
    openid,
    profile: profile
      ? {
        ...profile,
        avatarUrl,
      }
      : null,
    roles: {
      inquiryAdmin: resolveAdminRole(openid, "INQUIRY_ADMIN_OPENIDS"),
      caseAdmin: resolveAdminRole(openid, "CASE_ADMIN_OPENIDS"),
      notificationAdmin: resolveAdminRole(openid, "NOTIFICATION_ADMIN_OPENIDS"),
    },
  });
}

async function saveUserProfile(event, openid) {
  const validation = validateUserProfileDraft(event.profile || event.data || {});
  if (!validation.valid) return fail(validation.code, validation.message);

  const existing = await findUserProfile(openid);
  const data = {
    ...validation.data,
    openid,
    updatedAt: db.serverDate(),
  };

  if (existing && existing._id) {
    await db.collection(USER_PROFILE_COLLECTION).doc(existing._id).update({ data });
    return ok({
      profile: validation.data,
    });
  }

  await db.collection(USER_PROFILE_COLLECTION).add({
    data: {
      ...data,
      createdAt: db.serverDate(),
    },
  });
  return ok({
    profile: validation.data,
  });
}

exports.main = async (event = {}) => {
  const { OPENID, APPID } = cloud.getWXContext();
  const action = trimText(event.action);

  if (!OPENID) {
    return fail("UNAUTHORIZED", "未获取到微信身份");
  }

  try {
    if (action === "submitInquiry") return submitInquiry(event, OPENID);
    if (action === "getMyInquirySummary") return getMyInquirySummary(OPENID);
    if (action === "getInquiryBadgeSummary") return getInquiryBadgeSummary(OPENID);
    if (action === "listMyInquiries") return listMyInquiries(event, OPENID);
    if (action === "getMyInquiryDetail") return getMyInquiryDetail(event, OPENID);
    if (action === "markInquiryMessagesRead") {
      return markInquiryMessagesRead(event, OPENID);
    }
    if (action === "saveInquiryReplySubscription") {
      return saveInquiryReplySubscription(event, OPENID);
    }
    if (action === "submitFeedback") return submitFeedback(event, OPENID);
    if (action === "fetchSubscriptionStatus") return fetchSubscriptionStatus(OPENID);
    if (action === "verifySubscriptionTemplates") {
      return verifySubscriptionTemplates(APPID || "");
    }
    if (action === "saveSubscriptionGrant") return saveSubscriptionGrant(event, OPENID);
    if (action === "getProfile") return getUserProfile(OPENID);
    if (action === "getSessionSummary") return getSessionSummary(OPENID);
    if (action === "saveProfile") return saveUserProfile(event, OPENID);
    return fail("UNKNOWN_ACTION", "未知用户数据操作");
  } catch (error) {
    console.error("userData error", {
      action: action.slice(0, 48),
      code: normalizeSafeErrorCode(error),
    });
    return fail("SERVER_ERROR", "用户数据服务异常，请稍后重试");
  }
};
