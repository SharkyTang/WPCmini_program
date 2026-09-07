const crypto = require("node:crypto");
const https = require("node:https");
const { URL } = require("node:url");
const cloud = require("wx-server-sdk");
const {
  BANNER_COLLECTION,
  CASE_ADMIN_OPTIONS,
  CASE_BATCH_MAX,
  CASE_GALLERY_MAX,
  CASE_COLLECTION,
  CASE_SCAN_BATCH_SIZE,
  HOME_DISPLAY_LIMITS,
  IMAGE_URL_BATCH_SIZE,
  SEARCH_FETCH_LIMIT,
  PINNED_CASE_LIMIT,
  VIDEO_DURATION_SECONDS_MAX,
  VIDEO_POSTER_UPLOAD_BYTES,
  VIDEO_UPLOAD_BYTES,
  VIDEO_UPLOAD_PREFIX,
  buildPreparedVideoUpload,
  buildBatchCasePatch,
  buildCaseKeywords,
  buildHomepageDisplayItems,
  filterCaseItems,
  filterCaseItemsV2,
  generateSequentialCaseId,
  getCloudFilePath,
  isCloudFileFromEnvironment,
  getActivatedHomepageSlots,
  getCaseIdNumber,
  getCaseVideoFileIds,
  getPreparedVideoUploadId,
  getAdminDisplayName,
  getEnvList,
  getRecordVersion,
  hasCaseImageChanges,
  hasCaseVideoChanges,
  isAdminActor,
  isWebAdminUploadFile,
  isPreparedVideoUploadFile,
  isVideoUploadFileForActor,
  isWebWriteEnabled,
  normalizeCaseIds,
  normalizeAdminListLimit,
  normalizeClientMutationId,
  normalizeCloudFileIds,
  normalizeHomepageDisplaySlot,
  normalizeHttpsMediaUrl,
  normalizePage,
  normalizePageSize,
  normalizeUploadJobStatus,
  normalizeVisibilityFilter,
  paginateCaseItems,
  resolveAdminActor,
  sanitizeCasePayload,
  sanitizeVideoPatch,
  sortCaseItemsV2,
  trimText,
  validateExpectedVersion,
  validateHomepageDisplayCapacity,
  validateHomepageOrders,
  validateWebImageVariants,
  validateWebSourceFiles,
} = require("./caseAdminLogic");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();
const _ = db.command;
const RECENT_CASE_WINDOW_MS = 24 * 60 * 60 * 1000;
const CATALOG_META_COLLECTION = "catalog_meta";
const CATALOG_META_DOCUMENT_ID = "current";
const PURGE_JOB_COLLECTION = "case_admin_purge_jobs";
const PURGE_GUARD_DOCUMENT_ID = "purge_guard_current";
// CloudBase functions can be configured up to 900 seconds. Keep the lease
// comfortably beyond that ceiling so a live invocation can never lose its
// fence merely because its configured timeout was increased.
const PURGE_GUARD_LEASE_MS = 30 * 60 * 1000;
// Storage deletion has no documented cancellation signal. Stop awaiting an
// individual request well before the lease can expire, then deliberately keep
// the guard active until its lease expires. This prevents an ambiguous,
// still-in-flight request from racing a newly introduced image reference.
const PURGE_DELETE_CALL_TIMEOUT_MS = 45 * 1000;
const UPLOAD_JOB_COLLECTION = "case_admin_upload_jobs";
const ACTIVITY_FEED_COLLECTION = "case_admin_activity_feed";
const ACTIVITY_OUTBOX_VIEWER_UID = "__server_outbox__";
const ACTIVITY_OUTBOX_REPAIR_LIMIT = 10;
const ADMIN_RECORD_RETENTION_LIMIT = 50;
const VIDEO_UPLOAD_INTENT_COLLECTION = "case_admin_video_upload_intents";
const VIDEO_UPLOAD_INTENT_TTL_MS = 30 * 60 * 1000;
const VIDEO_HEAD_TIMEOUT_MS = 10 * 1000;
const VIDEO_HEAD_REDIRECT_LIMIT = 2;
const WEB_WRITE_ACTIONS = new Set([
  "createCase",
  "updateCase",
  "batchPatchCases",
  "moveCasesToTrash",
  "restoreCases",
  "reorderCases",
  "setHomeSectionOrder",
  "setCaseVisibility",
  "deleteCase",
  "cleanupUnreferencedFiles",
  "prepareVideoUpload",
  "permanentlyDeleteCases",
  "registerUploadItems",
  "updateUploadItemStatus",
  "removeUploadItem",
]);
const ACTIVITY_SYNC_ACTIONS = new Set([
  "registerUploadItems",
  "updateUploadItemStatus",
  "removeUploadItem",
  "listSharedUploadItems",
  "listAdminActivity",
]);
const PERMANENT_DELETE_ACTIONS = new Set([
  "permanentlyDeleteCases",
]);

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

function failFromValidation(validation) {
  return {
    ok: false,
    code: validation.code,
    message: validation.message,
    ...(validation.currentVersion ? { currentVersion: validation.currentVersion } : {}),
    ...(validation.slot ? { slot: validation.slot } : {}),
    ...(validation.limit ? { limit: validation.limit } : {}),
  };
}

function actorAuditFields(actor, phase = "updated") {
  const fields = {
    [`${phase}ByActor`]: actor,
  };
  if (actor && actor.type === "wechat_openid") {
    fields[`${phase}ByOpenid`] = actor.id;
  }
  return fields;
}

function getExpectedVersion(event, id) {
  if (event && event.expectedVersions && typeof event.expectedVersions === "object") {
    return event.expectedVersions[id];
  }
  return event && event.expectedVersion;
}

function isActivitySyncEnabled() {
  return isWebWriteEnabled(process.env.ADMIN_ACTIVITY_SYNC_ENABLED);
}

function isPermanentDeleteEnabled() {
  return isWebWriteEnabled(process.env.ADMIN_PERMANENT_DELETE_ENABLED);
}

function isVideoUploadEnabled() {
  return isWebWriteEnabled(process.env.VIDEO_UPLOAD_ENABLED);
}

function isVideoDisplayEnabled() {
  return isWebWriteEnabled(process.env.VIDEO_DISPLAY_ENABLED);
}

function getRuntimeCloudEnvironment() {
  return trimText(process.env.TCB_ENV || process.env.SCF_NAMESPACE);
}

function getDeterministicDocumentId(prefix, value) {
  const digest = crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex")
    .slice(0, 40);
  return `${prefix}_${digest}`;
}

function getUploadJobDocumentId(actor, mutationId) {
  return getDeterministicDocumentId("upload", `${actor.id}:${mutationId}`);
}

function getPurgeJobDocumentId(actor, clientMutationId) {
  return getDeterministicDocumentId("purge", `${actor.id}:${clientMutationId}`);
}

async function getDocumentOrNull(collectionName, id, source = db) {
  try {
    const response = await source.collection(collectionName).doc(id).get();
    return response.data || null;
  } catch (error) {
    if (isDocumentNotFoundError(error)) return null;
    throw error;
  }
}

async function getPurgeGuard(source = db) {
  return getDocumentOrNull(PURGE_JOB_COLLECTION, PURGE_GUARD_DOCUMENT_ID, source);
}

async function assertNoActivePurgeCleanup(source = db) {
  const guard = await getPurgeGuard(source);
  if (guard && guard.status === "active" && trimText(guard.activeJobId)) {
    if (isPurgeGuardLeaseExpired(guard)) {
      // Fence the expired owner in the same transaction as the image write.
      // A late renewal conflicts with this write and must re-read the idle
      // token before it can reach another storage deletion batch.
      await source
        .collection(PURGE_JOB_COLLECTION)
        .doc(PURGE_GUARD_DOCUMENT_ID)
        .set({
          data: {
            status: "idle",
            activeJobId: "",
            activeRunToken: "",
            leaseExpiresAt: null,
            updatedAt: db.serverDate(),
          },
        });
      return;
    }
    const error = new Error("回收站正在安全清理图片，请稍后重试图片保存");
    error.code = "PURGE_CLEANUP_IN_PROGRESS";
    throw error;
  }
}

function getPurgeRunToken() {
  return crypto.randomBytes(24).toString("hex");
}

function getDateTimestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const parsed = Date.parse(trimText(value));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function isPurgeGuardLeaseExpired(guard, now = Date.now()) {
  const expiresAt = getDateTimestamp(guard && guard.leaseExpiresAt);
  // Every guard written by the token-based protocol has a valid lease. Older
  // or partially written guards without one cannot be proven live and would
  // otherwise lock image writes forever, so fence them as expired.
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

async function acquirePurgeGuard(jobId, runToken) {
  const leaseExpiresAt = new Date(Date.now() + PURGE_GUARD_LEASE_MS);
  await withTransaction(async (transaction) => {
    const ref = transaction
      .collection(PURGE_JOB_COLLECTION)
      .doc(PURGE_GUARD_DOCUMENT_ID);
    const current = await getPurgeGuard(transaction);
    if (current && current.status === "active" && trimText(current.activeJobId)) {
      const ownsGuard = current.activeJobId === jobId
        && trimText(current.activeRunToken) === runToken;
      if (!ownsGuard && !isPurgeGuardLeaseExpired(current)) {
        const error = new Error("永久删除任务正在清理图片，请稍后重试");
        error.code = "PURGE_CLEANUP_BUSY";
        throw error;
      }
    }
    await ref.set({
      data: {
        status: "active",
        activeJobId: jobId,
        activeRunToken: runToken,
        leaseExpiresAt,
        updatedAt: db.serverDate(),
      },
    });
  }, { required: true });
}

async function releasePurgeGuard(jobId, runToken) {
  return withTransaction(async (transaction) => {
    const ref = transaction
      .collection(PURGE_JOB_COLLECTION)
      .doc(PURGE_GUARD_DOCUMENT_ID);
    const current = await getPurgeGuard(transaction);
    if (!current || current.status !== "active") return true;
    if (
      current.activeJobId !== jobId
      || trimText(current.activeRunToken) !== runToken
    ) return false;
    await ref.set({
      data: {
        status: "idle",
        activeJobId: "",
        activeRunToken: "",
        leaseExpiresAt: null,
        updatedAt: db.serverDate(),
      },
    });
    return true;
  }, { required: true });
}

async function renewPurgeGuardLease(jobId, runToken) {
  return withTransaction(async (transaction) => {
    const ref = transaction
      .collection(PURGE_JOB_COLLECTION)
      .doc(PURGE_GUARD_DOCUMENT_ID);
    const current = await getPurgeGuard(transaction);
    if (
      !current
      || current.status !== "active"
      || current.activeJobId !== jobId
      || trimText(current.activeRunToken) !== runToken
    ) {
      const error = new Error("永久删除任务已失去清理锁，请重新恢复任务");
      error.code = "PURGE_CLEANUP_FENCE_LOST";
      throw error;
    }
    await ref.set({
      data: {
        status: "active",
        activeJobId: jobId,
        activeRunToken: runToken,
        leaseExpiresAt: new Date(Date.now() + PURGE_GUARD_LEASE_MS),
        updatedAt: db.serverDate(),
      },
    });
    return true;
  }, { required: true });
}

function requireWebActor(actor) {
  return actor && actor.type === "cloudbase_uid"
    ? null
    : fail("WEB_ADMIN_REQUIRED", "此操作仅支持电脑后台管理员");
}

function getActivityViewers() {
  return getEnvList(process.env.CASE_ADMIN_UIDS);
}

function buildSanitizedActivityPayload(activity, actor, eventId) {
  const actorType = trimText(actor && actor.type);
  const actorId = trimText(actor && actor.id);
  return {
    eventId: trimText(eventId),
    actor: actorType && actorId ? { type: actorType, id: actorId } : null,
    actorDisplayName: trimText(activity && activity.actorDisplayName).slice(0, 80)
      || getAdminDisplayName(actor, process.env),
    action: trimText(activity && activity.action),
    targetType: trimText(activity && activity.targetType) || "case",
    targetId: trimText(activity && activity.targetId),
    title: trimText(activity && activity.title).slice(0, 120),
    caseId: trimText(activity && activity.caseId).slice(0, 80),
    batchId: trimText(activity && activity.batchId).slice(0, 120),
    mutationId: trimText(activity && activity.mutationId).slice(0, 120),
    status: normalizeUploadJobStatus(activity && activity.status),
    imageCount: Math.max(0, Math.min(9, Number(activity && activity.imageCount) || 0)),
  };
}

function getActivityOutboxDocumentId(eventId) {
  return getDeterministicDocumentId("outbox", eventId);
}

async function persistActivityOutbox(payload) {
  const documentId = getActivityOutboxDocumentId(payload.eventId);
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await db.collection(ACTIVITY_FEED_COLLECTION).doc(documentId).set({
        data: {
          ...payload,
          viewerUid: ACTIVITY_OUTBOX_VIEWER_UID,
          serverOutbox: true,
          createdAt: db.serverDate(),
          updatedAt: db.serverDate(),
        },
      });
      return documentId;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("管理员动态补偿记录写入失败");
}

async function fanoutSanitizedActivity(payload, viewers = getActivityViewers()) {
  if (!viewers.length) {
    return [{
      status: "rejected",
      reason: new Error("管理员动态接收者尚未配置"),
    }];
  }
  const results = await Promise.allSettled(viewers.map(async (viewerUid) => {
    const documentId = getDeterministicDocumentId(
      "feed",
      `${payload.eventId}:${viewerUid}`
    );
    await db.collection(ACTIVITY_FEED_COLLECTION).doc(documentId).set({
      data: {
        ...payload,
        viewerUid,
        createdAt: db.serverDate(),
      },
    });
  }));
  return results.filter((result) => result.status === "rejected");
}

async function removeActivityOutbox(documentId) {
  try {
    await db.collection(ACTIVITY_FEED_COLLECTION).doc(documentId).remove();
    return true;
  } catch (error) {
    if (isDocumentNotFoundError(error)) return true;
    console.warn("case admin activity outbox removal deferred", error);
    return false;
  }
}

async function writeAdminActivity(activity, actor, dedupeKey) {
  if (!isActivitySyncEnabled()) return false;
  const viewers = getActivityViewers();
  if (!viewers.length) return false;
  const eventId = getDeterministicDocumentId("activity", dedupeKey);
  const payload = buildSanitizedActivityPayload(activity, actor, eventId);
  const outboxId = await persistActivityOutbox(payload);
  const failures = await fanoutSanitizedActivity(payload, viewers);
  if (failures.length) {
    const error = new Error(`管理员动态有 ${failures.length} 个副本待修复`);
    error.code = "ACTIVITY_FANOUT_PARTIAL";
    error.causes = failures.map((result) => result.reason);
    throw error;
  }
  await removeActivityOutbox(outboxId);
  return true;
}

async function repairAdminActivityOutboxesSafe() {
  try {
    const response = await db
      .collection(ACTIVITY_FEED_COLLECTION)
      .where({ viewerUid: ACTIVITY_OUTBOX_VIEWER_UID })
      .orderBy("createdAt", "asc")
      .limit(ACTIVITY_OUTBOX_REPAIR_LIMIT)
      .get();
    for (const item of response.data || []) {
      if (!item || item.serverOutbox !== true || !trimText(item.eventId)) continue;
      try {
        const payload = buildSanitizedActivityPayload(
          item,
          item.actor,
          item.eventId
        );
        const failures = await fanoutSanitizedActivity(payload);
        if (!failures.length) {
          await removeActivityOutbox(item._id || getActivityOutboxDocumentId(item.eventId));
        }
      } catch (error) {
        console.warn("case admin activity outbox repair deferred", error);
      }
    }
  } catch (error) {
    // Polling endpoints must continue to serve their primary data even when
    // activity repair is temporarily unavailable.
    console.warn("case admin activity outbox scan deferred", error);
  }
}

async function writeAdminActivitySafe(activity, actor, dedupeKey) {
  try {
    return await writeAdminActivity(activity, actor, dedupeKey);
  } catch (error) {
    // Activity synchronization must never turn a committed case mutation into
    // a client-visible failure. The list endpoint/polling will recover later.
    console.warn("case admin activity write deferred", error);
    return false;
  }
}

function normalizeStringList(value, allowedValues) {
  const input = Array.isArray(value)
    ? value
    : value && Array.isArray(value.values)
      ? value.values
      : [];
  const allowed = new Set(allowedValues || []);
  return Array.from(new Set(
    input.map(trimText).filter((item) => item && allowed.has(item))
  ));
}

function normalizeUploadJobInput(input = {}) {
  const mutation = normalizeClientMutationId(input.mutationId || input.clientMutationId);
  if (!mutation.valid || !mutation.value) {
    return {
      valid: false,
      code: mutation.code || "MUTATION_ID_REQUIRED",
      message: mutation.message || "上传任务必须携带任务编号",
    };
  }
  const uploadBatch = normalizeUploadBatchId(
    input.uploadBatchId,
    "",
    true
  );
  if (!uploadBatch.valid) return uploadBatch;
  const imageCount = Number(input.imageCount);
  if (!Number.isInteger(imageCount) || imageCount < 1 || imageCount > CASE_GALLERY_MAX) {
    return {
      valid: false,
      code: "INVALID_IMAGE_COUNT",
      message: `单个上传任务必须包含 1-${CASE_GALLERY_MAX} 张图片`,
    };
  }
  const status = normalizeUploadJobStatus(input.status || "waiting");
  if (!status) {
    return { valid: false, code: "INVALID_UPLOAD_STATUS", message: "上传任务状态无效" };
  }
  return {
    valid: true,
    data: {
      mutationId: mutation.value,
      uploadBatchId: uploadBatch.value,
      title: (trimText(input.title) || "未命名案例").slice(0, 120),
      imageCount,
      packageTypes: normalizeStringList(input.packageTypes, CASE_ADMIN_OPTIONS.packageTypes),
      scenes: normalizeStringList(input.scenes, CASE_ADMIN_OPTIONS.scenes),
      status,
    },
  };
}

function isAllowedUploadStatusTransition(currentStatus, nextStatus) {
  if (currentStatus === nextStatus) return true;
  if (currentStatus === "done") return false;
  if (currentStatus === "needs_tags") return nextStatus === "done";
  if (currentStatus === "failed") {
    return [
      "waiting",
      "uploading",
      "processing",
      "creating",
      "needs_tags",
      "done",
    ].includes(nextStatus);
  }
  if (nextStatus === "failed") return true;
  const ranks = {
    waiting: 0,
    uploading: 1,
    processing: 2,
    creating: 3,
    needs_tags: 4,
    done: 5,
  };
  return Number.isInteger(ranks[currentStatus])
    && Number.isInteger(ranks[nextStatus])
    && ranks[nextStatus] > ranks[currentStatus];
}

function getUploadActivityAction(status, fallback = "upload_updated") {
  return ({
    waiting: "upload_queued",
    uploading: "upload_started",
    processing: "upload_processing",
    creating: "case_creating",
    needs_tags: "upload_completed",
    done: "upload_completed",
    failed: "upload_failed",
  })[status] || fallback;
}

function loadOfficialCloudbaseApp() {
  let sdk;
  try {
    // Kept lazy so the legacy WeChat runtime can still start during a staged
    // dependency rollout. Production deployments include this dependency.
    sdk = require("@cloudbase/node-sdk");
  } catch (error) {
    return { available: false, app: null, error: null };
  }
  try {
    const app = sdk.init({
      env: sdk.SYMBOL_CURRENT_ENV || process.env.TCB_ENV || process.env.SCF_NAMESPACE,
    });
    return { available: true, app, error: null };
  } catch (error) {
    return { available: true, app: null, error };
  }
}

async function loadOfficialCloudbaseUserInfo() {
  const loaded = loadOfficialCloudbaseApp();
  if (loaded.error || !loaded.app) {
    return {
      available: loaded.available,
      userInfo: null,
      error: loaded.error,
    };
  }
  try {
    return {
      available: true,
      userInfo: loaded.app.auth().getUserInfo(),
      error: null,
    };
  } catch (error) {
    return { available: true, userInfo: null, error };
  }
}

async function resolveRequestIdentity() {
  let wxContext = {};
  try {
    wxContext = cloud.getWXContext() || {};
  } catch (error) {
    return { identity: null, error };
  }
  const official = await loadOfficialCloudbaseUserInfo();
  if (official.error && !trimText(wxContext.OPENID)) {
    return { identity: null, error: official.error };
  }
  const userInfo = official.userInfo || {};
  if (userInfo.isAnonymous === true && !trimText(wxContext.OPENID || userInfo.openId)) {
    return {
      identity: { authenticated: false, actor: null },
      error: null,
    };
  }
  const mergedContext = {
    ...wxContext,
    OPENID: trimText(wxContext.OPENID || userInfo.openId),
    UID: userInfo.isAnonymous === true ? "" : trimText(userInfo.uid),
  };
  return {
    identity: resolveAdminActor(mergedContext, process.env),
    error: null,
  };
}

async function withTransaction(callback, options = {}) {
  if (typeof db.runTransaction === "function") {
    return db.runTransaction(callback);
  }
  if (options.required === true) {
    const error = new Error("当前数据库 SDK 不支持事务写入");
    error.code = "TRANSACTION_UNAVAILABLE";
    throw error;
  }
  // Older mocks and legacy SDKs do not expose transactions. Production uses
  // wx-server-sdk 2.6+ where runTransaction is available.
  return callback(db);
}

async function fetchAllCases(options = {}) {
  const items = [];
  let offset = 0;
  const field = options.field;
  while (true) {
    let query = db
      .collection(CASE_COLLECTION)
      .orderBy("_id", "asc")
      .skip(offset)
      .limit(CASE_SCAN_BATCH_SIZE);
    if (field && typeof query.field === "function") query = query.field(field);
    const response = await query.get();
    const batch = response.data || [];
    items.push(...batch);
    if (batch.length < CASE_SCAN_BATCH_SIZE) break;
    offset += batch.length;
  }
  return items;
}

async function fetchCasesByIds(ids = [], source = db) {
  const chunks = [];
  for (let offset = 0; offset < ids.length; offset += 10) {
    chunks.push(ids.slice(offset, offset + 10));
  }
  const responses = new Array(chunks.length);
  let cursor = 0;
  async function worker() {
    while (cursor < chunks.length) {
      const index = cursor;
      cursor += 1;
      const chunk = chunks[index];
      responses[index] = await source
        .collection(CASE_COLLECTION)
        .where({ _id: _.in(chunk) })
        .limit(chunk.length)
        .get();
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(5, chunks.length) }, () => worker())
  );
  const byId = new Map(
    responses
      .flatMap((response) => response.data || [])
      .map((item) => [trimText(item && item._id), item])
  );
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

function isDocumentNotFoundError(error) {
  const code = trimText(error && (error.code || error.errCode)).toUpperCase();
  const message = trimText(error && (error.message || error.errMsg));
  return (
    code.includes("NOT_FOUND") ||
    code === "DOCUMENT_NOT_FOUND" ||
    /(?:document|doc).*(?:not found|does not exist)/i.test(message) ||
    /文档.*不存在/.test(message)
  );
}

function normalizeLogErrorCode(error, fallback = "UNKNOWN_ERROR") {
  const code = trimText(error && (error.code || error.errCode || error.status))
    .toUpperCase();
  return /^[A-Z0-9_.:-]{1,80}$/.test(code) ? code : fallback;
}

function ensureAllCasesFound(ids, items) {
  const found = new Set(items.map((item) => trimText(item && item._id)));
  const missingIds = ids.filter((id) => !found.has(id));
  return missingIds.length
    ? {
      valid: false,
      code: "CASE_NOT_FOUND",
      message: `以下案例不存在或已删除：${missingIds.join("、")}`,
      missingIds,
    }
    : { valid: true };
}

function validateCaseReadyForVisibility(item = {}) {
  if (item.isVisible !== true) return { valid: true };
  if (!trimText(item.title) || !trimText(item.coverImage)) {
    return { valid: false, code: "CASE_NOT_READY", message: "案例标题或图片未补齐，暂不能上架" };
  }
  if (!Array.isArray(item.packageTypes && item.packageTypes.values)
    || !item.packageTypes.values.length) {
    return { valid: false, code: "CASE_NOT_READY", message: "案例缺少包装标签，补充后才能上架" };
  }
  return { valid: true };
}

function validateAllHomepageCapacity(cases, banners) {
  for (const slot of Object.keys(HOME_DISPLAY_LIMITS)) {
    const items = buildHomepageDisplayItems(cases, banners, {
      slot,
      applyLimit: false,
    });
    if (items.length > HOME_DISPLAY_LIMITS[slot]) {
      return {
        valid: false,
        code: "HOME_DISPLAY_LIMIT_REACHED",
        slot,
        limit: HOME_DISPLAY_LIMITS[slot],
        message: `${slot === "banner" ? "首页轮播" : slot === "popular" ? "热门产品" : "最新产品"}超过展示上限`,
      };
    }
  }
  return { valid: true };
}

async function bumpCatalogRevision() {
  try {
    const revision = _ && typeof _.inc === "function" ? _.inc(1) : 2;
    const response = await db.collection(CATALOG_META_COLLECTION).doc(CATALOG_META_DOCUMENT_ID).update({
      data: {
        revision,
        updatedAt: db.serverDate(),
      },
    });
    if (
      response &&
      response.stats &&
      Number(response.stats.updated) === 0
    ) {
      const missing = new Error("catalog meta document not found");
      missing.code = "DOCUMENT_NOT_FOUND";
      throw missing;
    }
    return true;
  } catch (error) {
    if (!isDocumentNotFoundError(error)) {
      console.warn("catalog revision update failed", error);
      return false;
    }
    try {
      const cases = await fetchAllCases({ field: { caseId: true } });
      const nextCaseNumber = getCaseIdNumber(generateSequentialCaseId(cases));
      await db.collection(CATALOG_META_COLLECTION).doc(CATALOG_META_DOCUMENT_ID).set({
        data: {
          revision: 1,
          nextCaseNumber,
          updatedAt: db.serverDate(),
        },
      });
      return true;
    } catch (createError) {
      console.warn("catalog revision update failed", createError);
      return false;
    }
  }
}

async function listCases(event) {
  const page = normalizePage(event.page);
  const pageSize = normalizePageSize(event.pageSize);
  const visibility = normalizeVisibilityFilter(event.visibility);
  const keyword = trimText(event.keyword);
  const activeCases = (await fetchAllCases()).filter((item) => !item.deletedAt);
  const filteredItems = sortCaseItemsV2(
    filterCaseItems(activeCases, { keyword, visibility }),
    { field: "sortOrder", direction: "asc" }
  );
  const start = (page - 1) * pageSize;
  return ok({
    items: filteredItems.slice(start, start + pageSize),
    page,
    pageSize,
    hasMore: start + pageSize < filteredItems.length,
  });
}

async function getAdminConfig(actor) {
  const emptyHomeSectionOrders = Object.keys(HOME_DISPLAY_LIMITS).reduce((orders, slot) => {
    orders[slot] = [];
    return orders;
  }, {});
  let homeSectionOrders = emptyHomeSectionOrders;
  try {
    const cases = await fetchAllCases();
    homeSectionOrders = Object.keys(HOME_DISPLAY_LIMITS).reduce((orders, slot) => {
      orders[slot] = buildHomepageDisplayItems(cases, [], {
        slot,
        applyLimit: false,
      }).map((item) => item.id);
      return orders;
    }, {});
  } catch (error) {
    // Configuration and the write gate must remain observable even while the
    // case collection is unavailable. The list endpoint reports the database
    // failure separately instead of misleading the operator with read-only UI.
    console.error("caseAdmin config case scan error", error);
  }
  const writeEnabled = actor && actor.type === "cloudbase_uid"
    ? isWebWriteEnabled(process.env.ADMIN_WEB_WRITE_ENABLED)
    : true;
  const activitySyncEnabled = Boolean(
    actor && actor.type === "cloudbase_uid" && isActivitySyncEnabled()
  );
  const permanentDeleteEnabled = Boolean(
    actor && actor.type === "cloudbase_uid" && isPermanentDeleteEnabled()
  );
  return ok({
    config: {
      options: {
        wineTypes: CASE_ADMIN_OPTIONS.wineType,
        packageTypes: CASE_ADMIN_OPTIONS.packageTypes,
        styles: CASE_ADMIN_OPTIONS.styles,
        priceLevels: CASE_ADMIN_OPTIONS.priceLevel,
        scenes: CASE_ADMIN_OPTIONS.scenes,
        statuses: CASE_ADMIN_OPTIONS.statuses,
      },
      limits: {
        gallery: CASE_GALLERY_MAX,
        batch: CASE_BATCH_MAX,
        uploadBytes: 20 * 1024 * 1024,
        videoUploadBytes: VIDEO_UPLOAD_BYTES,
        videoDurationSeconds: VIDEO_DURATION_SECONDS_MAX,
        videoPosterUploadBytes: VIDEO_POSTER_UPLOAD_BYTES,
        homepage: HOME_DISPLAY_LIMITS,
      },
      features: {
        videoUploadEnabled: isVideoUploadEnabled(),
        videoDisplayEnabled: isVideoDisplayEnabled(),
      },
      writeEnabled,
      activitySyncEnabled,
      permanentDeleteEnabled,
      actorDisplayName: getAdminDisplayName(actor, process.env),
      homeSectionOrders,
      upload: {
        acceptedExtensions: [".jpg", ".jpeg", ".png", ".webp"],
        pathPrefix: actor && actor.type === "cloudbase_uid"
          ? `wine-packaging/admin-web/${encodeURIComponent(actor.id)}/`
          : "wine-packaging/",
        video: {
          acceptedExtensions: [".mp4"],
          acceptedMimeTypes: ["video/mp4"],
          pathPrefix: `${VIDEO_UPLOAD_PREFIX}/`,
        },
        videoPoster: {
          acceptedExtensions: [".jpg", ".jpeg", ".png", ".webp"],
          acceptedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
          pathPrefix: `${VIDEO_UPLOAD_PREFIX}/`,
        },
      },
    },
    // Temporary aliases keep early desktop builds compatible.
    webWriteEnabled: writeEnabled,
    homeSectionOrders,
  });
}

async function listCasesV2(event) {
  const flatFilters = {
    keyword: event.keyword,
    wineType: event.wineType,
    packageTypes: event.packageTypes,
    styles: event.styles,
    priceLevel: event.priceLevel,
    scenes: event.scenes,
    statuses: event.statuses,
    homeSections: event.homeSections || event.homeSection,
    visibility: event.visibility,
    isPinned: event.isPinned,
    trash: event.trash,
  };
  const filters = {
    ...flatFilters,
    ...(event.filters && typeof event.filters === "object" ? event.filters : {}),
  };
  const allCases = await fetchAllCases();
  const filtered = filterCaseItemsV2(allCases, filters);
  const sorted = sortCaseItemsV2(filtered, event.sort);
  return ok(paginateCaseItems(sorted, event.page, event.pageSize));
}

async function listRecentCases(event) {
  const page = normalizePage(event.page);
  const pageSize = normalizePageSize(event.pageSize);
  const since = new Date(Date.now() - RECENT_CASE_WINDOW_MS);
  const response = await db
    .collection(CASE_COLLECTION)
    .where({
      isVisible: true,
      createdAt: _.gte(since),
    })
    .orderBy("createdAt", "desc")
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get();
  return ok({
    items: response.data || [],
    page,
    pageSize,
    hasMore: (response.data || []).length === pageSize,
    since: since.toISOString(),
  });
}

async function listHomepageDisplay(event) {
  const slot = normalizeHomepageDisplaySlot(event.slot);
  if (!slot) return fail("INVALID_HOME_SLOT", "首页展示位置无效");

  const casesRequest = fetchAllCases();
  const bannersRequest = slot === "banner"
    ? db
      .collection(BANNER_COLLECTION)
      .where({ isVisible: true })
      .orderBy("sortOrder", "asc")
      .limit(SEARCH_FETCH_LIMIT)
      .get()
    : Promise.resolve({ data: [] });
  const [caseItems, bannerResponse] = await Promise.all([casesRequest, bannersRequest]);
  const items = buildHomepageDisplayItems(caseItems, bannerResponse.data || [], {
    slot,
    keyword: trimText(event.keyword),
  });

  return ok({ slot, items });
}

async function getCase(event) {
  const id = trimText(event.id);
  if (!id) return fail("INVALID_ID", "缺少案例 ID");
  const response = await db.collection(CASE_COLLECTION).doc(id).get();
  const item = response.data || null;
  if (!item) return ok({ item: null });
  let urlMap = {};
  try {
    urlMap = await getTempUrlMap(getCaseVideoFileIds(item));
  } catch (error) {
    // A preview-signing outage must not make an otherwise valid case unreadable
    // or make a committed update look as though it failed.
    console.warn("case admin video preview resolution failed");
  }
  return ok({
    item: {
      ...item,
      videoPreviewUrl: trimText(item.videoFileID)
        ? urlMap[item.videoFileID] || ""
        : normalizeHttpsMediaUrl(item.videoUrl),
      videoPosterPreviewUrl: trimText(item.videoPosterFileID)
        ? urlMap[item.videoPosterFileID] || ""
        : normalizeHttpsMediaUrl(item.videoPoster),
    },
  });
}

function sameAdminActor(left, right) {
  return Boolean(
    left
    && right
    && trimText(left.type) === trimText(right.type)
    && trimText(left.id) === trimText(right.id)
  );
}

async function prepareVideoUpload(event, actor) {
  if (!isVideoUploadEnabled()) {
    return fail("VIDEO_UPLOAD_DISABLED", "视频上传功能尚未开启");
  }
  const id = trimText(event.id);
  if (!id) return fail("INVALID_ID", "缺少案例 ID");
  const existing = await getCaseById(id);
  if (!existing) return fail("CASE_NOT_FOUND", "案例不存在或已删除");
  if (existing.deletedAt) return fail("CASE_IN_TRASH", "回收站中的案例不能上传视频");

  const prepared = buildPreparedVideoUpload({
    actor,
    caseDocumentId: id,
    kind: event.kind,
    fileName: event.fileName,
    uploadId: crypto.randomBytes(16).toString("hex"),
  });
  if (!prepared.valid) return failFromValidation(prepared);
  const expiresAt = new Date(Date.now() + VIDEO_UPLOAD_INTENT_TTL_MS).toISOString();
  await db.collection(VIDEO_UPLOAD_INTENT_COLLECTION).doc(prepared.uploadId).set({
    data: {
      actor,
      caseDocumentId: id,
      kind: prepared.kind,
      cloudPath: prepared.cloudPath,
      status: "prepared",
      expiresAt,
      createdAt: db.serverDate(),
      updatedAt: db.serverDate(),
    },
  });
  return ok({
    uploadId: prepared.uploadId,
    cloudPath: prepared.cloudPath,
    kind: prepared.kind,
    expiresAt,
  });
}

async function validatePreparedVideoIntent(fileID, actor, caseDocumentId, kind, source = db) {
  const runtimeEnvironment = getRuntimeCloudEnvironment();
  if (!runtimeEnvironment) {
    return {
      valid: false,
      code: "STORAGE_ENV_UNAVAILABLE",
      message: "无法确认当前云存储环境，已停止绑定视频",
    };
  }
  if (!isCloudFileFromEnvironment(fileID, runtimeEnvironment)) {
    return {
      valid: false,
      code: "CROSS_ENV_VIDEO_FILE",
      message: "不能绑定其他云开发环境的视频文件",
    };
  }
  if (!isPreparedVideoUploadFile(fileID, actor, caseDocumentId, kind)) {
    return {
      valid: false,
      code: "INVALID_VIDEO_UPLOAD_PATH",
      message: "视频文件不属于当前管理员和案例的上传目录",
    };
  }
  const uploadId = getPreparedVideoUploadId(fileID);
  const intent = await getDocumentOrNull(VIDEO_UPLOAD_INTENT_COLLECTION, uploadId, source);
  if (
    !intent
    || !sameAdminActor(intent.actor, actor)
    || trimText(intent.caseDocumentId) !== trimText(caseDocumentId)
    || trimText(intent.kind) !== kind
    || trimText(intent.cloudPath) !== getCloudFilePath(fileID)
  ) {
    return {
      valid: false,
      code: "VIDEO_UPLOAD_NOT_PREPARED",
      message: "视频文件没有有效的上传凭据，请重新选择文件",
    };
  }
  const intentStatus = trimText(intent.status).toLowerCase();
  if (intentStatus !== "prepared" || intent.consumedAt) {
    return intentStatus === "cleanup_claimed"
      ? {
        valid: false,
        code: "VIDEO_UPLOAD_CLEANUP_CLAIMED",
        message: "该上传文件正在安全清理，请重新选择文件",
      }
      : {
        valid: false,
        code: "VIDEO_UPLOAD_ALREADY_USED",
        message: "视频上传凭据已被使用",
      };
  }
  const expiresAt = Date.parse(intent.expiresAt || "");
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return {
      valid: false,
      code: "VIDEO_UPLOAD_EXPIRED",
      message: "视频上传凭据已过期，请重新选择文件",
    };
  }
  return { valid: true, uploadId, intent };
}

function readHttpsHead(urlValue, redirectsRemaining = VIDEO_HEAD_REDIRECT_LIMIT) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlValue);
    } catch (error) {
      reject(new Error("云存储临时地址无效"));
      return;
    }
    if (url.protocol !== "https:") {
      reject(new Error("云存储临时地址必须使用 HTTPS"));
      return;
    }
    const request = https.request(url, { method: "HEAD" }, (response) => {
      const statusCode = Number(response.statusCode) || 0;
      const location = trimText(response.headers && response.headers.location);
      if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
        response.resume();
        if (redirectsRemaining <= 0) {
          reject(new Error("云存储临时地址重定向次数过多"));
          return;
        }
        let redirected;
        try {
          redirected = new URL(location, url);
        } catch (error) {
          reject(new Error("云存储重定向地址无效"));
          return;
        }
        if (redirected.protocol !== "https:") {
          reject(new Error("云存储重定向必须使用 HTTPS"));
          return;
        }
        readHttpsHead(redirected.toString(), redirectsRemaining - 1).then(resolve, reject);
        return;
      }
      response.resume();
      if (statusCode < 200 || statusCode >= 300) {
        reject(new Error("云存储文件不可读"));
        return;
      }
      resolve({ headers: response.headers || {} });
    });
    request.setTimeout(VIDEO_HEAD_TIMEOUT_MS, () => {
      request.destroy(new Error("云存储文件校验超时"));
    });
    request.on("error", reject);
    request.end();
  });
}

async function inspectVideoStorageFile(fileID, kind) {
  let tempResponse;
  try {
    tempResponse = await cloud.getTempFileURL({ fileList: [fileID] });
  } catch (error) {
    return {
      valid: false,
      code: "VIDEO_METADATA_UNAVAILABLE",
      message: "暂时无法校验视频文件，请稍后重试",
    };
  }
  const signed = tempResponse && Array.isArray(tempResponse.fileList)
    ? tempResponse.fileList.find((entry) => trimText(entry && entry.fileID) === fileID)
    : null;
  const signedUrl = trimText(signed && signed.tempFileURL);
  if (!signedUrl) {
    return {
      valid: false,
      code: "INVALID_VIDEO_STORAGE_FILE",
      message: "云存储文件不存在或无法访问",
    };
  }
  let head;
  try {
    head = await readHttpsHead(signedUrl);
  } catch (error) {
    return {
      valid: false,
      code: "VIDEO_METADATA_UNAVAILABLE",
      message: "暂时无法校验视频文件，请稍后重试",
    };
  }
  const size = Number(head.headers["content-length"]);
  const mime = trimText(head.headers["content-type"])
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!Number.isSafeInteger(size) || size <= 0 || !mime) {
    return {
      valid: false,
      code: "INVALID_VIDEO_STORAGE_FILE",
      message: "云存储文件不存在或元数据不完整",
    };
  }
  const isVideo = kind === "video";
  const allowedMimeTypes = isVideo
    ? ["video/mp4"]
    : ["image/jpeg", "image/png", "image/webp"];
  if (!allowedMimeTypes.includes(mime)) {
    return {
      valid: false,
      code: isVideo ? "INVALID_VIDEO_MIME" : "INVALID_VIDEO_POSTER_MIME",
      message: isVideo ? "云存储文件不是 MP4 视频" : "视频封面格式无效",
    };
  }
  const sizeLimit = isVideo ? VIDEO_UPLOAD_BYTES : VIDEO_POSTER_UPLOAD_BYTES;
  if (size > sizeLimit) {
    return {
      valid: false,
      code: isVideo ? "VIDEO_FILE_TOO_LARGE" : "VIDEO_POSTER_TOO_LARGE",
      message: isVideo ? "视频不能超过 100MB" : "视频封面不能超过 5MB",
    };
  }
  return { valid: true, size, mime };
}

async function isVideoFileReferencedByOtherCase(fileID, caseDocumentId) {
  const [videoResponse, posterResponse] = await Promise.all([
    db.collection(CASE_COLLECTION).where({ videoFileID: fileID }).field({ _id: true }).limit(2).get(),
    db.collection(CASE_COLLECTION).where({ videoPosterFileID: fileID }).field({ _id: true }).limit(2).get(),
  ]);
  return [...(videoResponse.data || []), ...(posterResponse.data || [])]
    .some((item) => trimText(item && item._id) !== trimText(caseDocumentId));
}

function getIntroducedVideoUploadFiles(videoPatch, current = {}) {
  if (!videoPatch || videoPatch.omitted || videoPatch.mode !== "upload") return [];
  const candidates = [
    {
      kind: "video",
      field: "videoFileID",
      fileID: trimText(videoPatch.data && videoPatch.data.videoFileID),
    },
    {
      kind: "poster",
      field: "videoPosterFileID",
      fileID: trimText(videoPatch.data && videoPatch.data.videoPosterFileID),
    },
  ];
  return candidates.filter(
    (item) => item.fileID && item.fileID !== trimText(current[item.field])
  );
}

function normalizeStoredVideoFileSize(value) {
  const size = Number(value);
  return Number.isSafeInteger(size) && size > 0 ? size : null;
}

async function getCaseById(id) {
  try {
    const response = await db.collection(CASE_COLLECTION).doc(id).get();
    return response.data || null;
  } catch (error) {
    if (isDocumentNotFoundError(error)) return null;
    throw error;
  }
}

async function getCreateCaseDefaults(options = {}) {
  const cases = await fetchAllCases({ field: { caseId: true } });
  const fallbackCaseId = generateSequentialCaseId(cases);
  const fallbackNumber = getCaseIdNumber(fallbackCaseId);
  let reservedNumber = fallbackNumber;

  try {
    if (options.requireAtomic === true && typeof db.runTransaction !== "function") {
      const unavailable = new Error("当前数据库 SDK 不支持事务编号预留");
      unavailable.code = "CASE_NUMBER_RESERVATION_FAILED";
      throw unavailable;
    }
    await withTransaction(async (transaction) => {
      const ref = transaction
        .collection(CATALOG_META_COLLECTION)
        .doc(CATALOG_META_DOCUMENT_ID);
      let meta = null;
      try {
        const response = await ref.get();
        meta = response && response.data;
      } catch (error) {
        if (!isDocumentNotFoundError(error)) throw error;
        meta = null;
      }
      const configured = Number(meta && meta.nextCaseNumber);
      reservedNumber = Number.isInteger(configured) && configured > 0
        ? Math.max(configured, fallbackNumber)
        : fallbackNumber;
      const data = {
        nextCaseNumber: reservedNumber + 1,
        updatedAt: db.serverDate(),
      };
      if (meta) {
        await ref.update({ data });
      } else if (typeof ref.set === "function") {
        await ref.set({ data: { revision: 0, ...data } });
      } else if (options.requireAtomic === true) {
        const unavailable = new Error("无法初始化案例编号");
        unavailable.code = "CASE_NUMBER_RESERVATION_FAILED";
        throw unavailable;
      }
    });
  } catch (error) {
    if (options.requireAtomic === true) {
      error.code = error.code || "CASE_NUMBER_RESERVATION_FAILED";
      throw error;
    }
    console.warn("case number reservation failed; using scanned fallback", error);
  }

  const defaultCaseId = `case_${String(reservedNumber).padStart(3, "0")}`;
  return {
    defaultCaseId,
    defaultSortOrder: reservedNumber,
  };
}

async function validateHomepageCapacity(nextCase, slots, excludedId = "") {
  if (!slots.length) return null;
  const [caseResponse, bannerResponse] = await Promise.all([
    fetchAllCases(),
    db
      .collection(BANNER_COLLECTION)
      .where({ isVisible: true })
      .field({ _id: true, caseId: true, image: true, sortOrder: true, isVisible: true })
      .limit(SEARCH_FETCH_LIMIT)
      .get(),
  ]);
  const validation = validateHomepageDisplayCapacity(
    caseResponse,
    bannerResponse.data || [],
    nextCase,
    { slots, excludedId }
  );
  return validation.valid ? null : fail(validation.code, validation.message);
}

function buildFileIdSet(records = [], field) {
  return new Set(
    records
      .flatMap((item) => {
        const value = item && item[field];
        return Array.isArray(value) ? value : [value];
      })
      .map(trimText)
      .filter((fileID) => fileID.indexOf("cloud://") === 0)
  );
}

async function fetchCaseImageFileIdSet(fileIDs = [], where = {}, options = {}) {
  const normalizedFileIDs = normalizeCloudFileIds(fileIDs);
  if (!normalizedFileIDs.length) return new Set();
  const [
    coverResponse,
    thumbnailResponse,
    galleryResponse,
    sourceGalleryResponse,
    galleryThumbnailResponse,
    coverBannerResponse,
    galleryBannerResponse,
  ] = await Promise.all([
    db.collection(CASE_COLLECTION).where({ ...where, coverImage: _.in(normalizedFileIDs) })
      .field({ coverImage: true }).limit(IMAGE_URL_BATCH_SIZE).get(),
    db.collection(CASE_COLLECTION).where({ ...where, coverThumbnail: _.in(normalizedFileIDs) })
      .field({ coverThumbnail: true }).limit(IMAGE_URL_BATCH_SIZE).get(),
    db.collection(CASE_COLLECTION).where({ ...where, galleryImages: _.in(normalizedFileIDs) })
      .field({ galleryImages: true }).limit(IMAGE_URL_BATCH_SIZE).get(),
    options.includeSources === false
      ? Promise.resolve({ data: [] })
      : db.collection(CASE_COLLECTION).where({ ...where, sourceGalleryImages: _.in(normalizedFileIDs) })
        .field({ sourceGalleryImages: true }).limit(IMAGE_URL_BATCH_SIZE).get(),
    db.collection(CASE_COLLECTION).where({ ...where, galleryThumbnails: _.in(normalizedFileIDs) })
      .field({ galleryThumbnails: true }).limit(IMAGE_URL_BATCH_SIZE).get(),
    db.collection(CASE_COLLECTION).where({ ...where, coverBanner: _.in(normalizedFileIDs) })
      .field({ coverBanner: true }).limit(IMAGE_URL_BATCH_SIZE).get(),
    db.collection(CASE_COLLECTION).where({ ...where, galleryBanners: _.in(normalizedFileIDs) })
      .field({ galleryBanners: true }).limit(IMAGE_URL_BATCH_SIZE).get(),
  ]);
  return new Set([
    ...buildFileIdSet(coverResponse.data || [], "coverImage"),
    ...buildFileIdSet(thumbnailResponse.data || [], "coverThumbnail"),
    ...buildFileIdSet(galleryResponse.data || [], "galleryImages"),
    ...buildFileIdSet(sourceGalleryResponse.data || [], "sourceGalleryImages"),
    ...buildFileIdSet(galleryThumbnailResponse.data || [], "galleryThumbnails"),
    ...buildFileIdSet(coverBannerResponse.data || [], "coverBanner"),
    ...buildFileIdSet(galleryBannerResponse.data || [], "galleryBanners"),
  ]);
}

async function fetchVisibleBannerFileIdSet(fileIDs = []) {
  const normalizedFileIDs = normalizeCloudFileIds(fileIDs);
  if (!normalizedFileIDs.length) return new Set();
  const [imageResponse, optimizedResponse] = await Promise.all([
    db.collection(BANNER_COLLECTION).where({
      isVisible: true,
      image: _.in(normalizedFileIDs),
    }).field({ image: true }).limit(IMAGE_URL_BATCH_SIZE).get(),
    db.collection(BANNER_COLLECTION).where({
      isVisible: true,
      optimizedImage: _.in(normalizedFileIDs),
    }).field({ optimizedImage: true }).limit(IMAGE_URL_BATCH_SIZE).get(),
  ]);
  return new Set([
    ...buildFileIdSet(imageResponse.data || [], "image"),
    ...buildFileIdSet(optimizedResponse.data || [], "optimizedImage"),
  ]);
}

async function getTempUrlMap(fileIDs = []) {
  if (!fileIDs.length) return {};
  const response = await cloud.getTempFileURL({
    fileList: fileIDs.slice(0, IMAGE_URL_BATCH_SIZE),
  });
  return (response.fileList || []).reduce((map, item) => {
    if (item && item.fileID && item.tempFileURL) {
      map[item.fileID] = item.tempFileURL;
    }
    return map;
  }, {});
}

async function getVisibleImageUrls(event) {
  const fileIDs = normalizeCloudFileIds(event.fileIDs || event.fileIds);
  if (!fileIDs.length) return ok({ urls: {} });

  const [caseFileIds, bannerFileIds] = await Promise.all([
    fetchCaseImageFileIdSet(fileIDs, { isVisible: true }, { includeSources: false }),
    fetchVisibleBannerFileIdSet(fileIDs),
  ]);
  const allowedFileIds = new Set([...caseFileIds, ...bannerFileIds]);
  const allowedRequestedFileIds = fileIDs.filter((fileID) => allowedFileIds.has(fileID));
  const urls = await getTempUrlMap(allowedRequestedFileIds);
  return ok({ urls });
}

async function getCaseImageUrls(event) {
  const fileIDs = normalizeCloudFileIds(event.fileIDs || event.fileIds);
  if (!fileIDs.length) return ok({ urls: {} });

  const caseFileIds = await fetchCaseImageFileIdSet(fileIDs);
  const allowedRequestedFileIds = fileIDs.filter((fileID) => caseFileIds.has(fileID));
  const urls = await getTempUrlMap(allowedRequestedFileIds);
  return ok({ urls });
}

async function registerUploadItems(event, actor) {
  const actorError = requireWebActor(actor);
  if (actorError) return actorError;
  const rawItems = Array.isArray(event.items) ? event.items : [];
  if (!rawItems.length || rawItems.length > CASE_BATCH_MAX) {
    return fail(
      "INVALID_UPLOAD_ITEMS",
      `每次必须登记 1-${CASE_BATCH_MAX} 个上传任务`
    );
  }
  const normalizedItems = [];
  const seenMutationIds = new Set();
  for (const rawItem of rawItems) {
    const normalized = normalizeUploadJobInput(rawItem);
    if (!normalized.valid) return failFromValidation(normalized);
    if (seenMutationIds.has(normalized.data.mutationId)) {
      return fail("DUPLICATE_MUTATION_ID", "同一批任务中不能包含重复任务编号");
    }
    seenMutationIds.add(normalized.data.mutationId);
    normalizedItems.push(normalized.data);
  }

  const createdItems = [];
  const existingItems = [];
  const removedItems = [];
  try {
    await withTransaction(async (transaction) => {
      createdItems.length = 0;
      existingItems.length = 0;
      removedItems.length = 0;
      const rows = [];
      for (const item of normalizedItems) {
        const id = getUploadJobDocumentId(actor, item.mutationId);
        const ref = transaction.collection(UPLOAD_JOB_COLLECTION).doc(id);
        const existing = await getDocumentOrNull(UPLOAD_JOB_COLLECTION, id, transaction);
        rows.push({ id, ref, item, existing });
      }
      for (const row of rows) {
        if (row.existing) {
          if (row.existing.tombstone === true || row.existing.status === "removed") {
            removedItems.push({ ...row.existing, _id: row.id });
          } else {
            existingItems.push({ ...row.existing, _id: row.id });
          }
          continue;
        }
        const data = {
          ...row.item,
          ownerUid: actor.id,
          ownerActor: actor,
          ownerDisplayName: getAdminDisplayName(actor, process.env),
          createdAt: db.serverDate(),
          updatedAt: db.serverDate(),
        };
        await row.ref.set({ data });
        createdItems.push({ _id: row.id, ...data });
      }
    }, { required: true });
  } catch (error) {
    if (error.code) return failFromValidation(error);
    throw error;
  }

  await Promise.all(createdItems.concat(existingItems).map((item) => writeAdminActivitySafe({
    action: getUploadActivityAction(item.status),
    targetType: "upload_job",
    targetId: item._id,
    title: item.title,
    batchId: item.uploadBatchId,
    mutationId: item.mutationId,
    status: item.status,
    imageCount: item.imageCount,
  }, actor, `upload-register:${actor.id}:${item.mutationId}`)));
  await Promise.all(removedItems.map((item) => writeAdminActivitySafe({
    action: "upload_removed",
    targetType: "upload_job",
    targetId: item._id,
    title: item.title,
    batchId: item.uploadBatchId,
    mutationId: item.mutationId,
    status: "removed",
    imageCount: item.imageCount,
  }, actor, `upload-remove:${actor.id}:${item.mutationId}`)));

  return ok({
    registered: createdItems.length,
    existing: existingItems.length,
    removed: removedItems.length,
    items: createdItems.concat(existingItems),
  });
}

async function updateUploadItemStatus(event, actor) {
  const actorError = requireWebActor(actor);
  if (actorError) return actorError;
  const mutation = normalizeClientMutationId(event.mutationId || event.clientMutationId);
  if (!mutation.valid || !mutation.value) {
    return failFromValidation(mutation.valid
      ? { code: "MUTATION_ID_REQUIRED", message: "缺少上传任务编号" }
      : mutation);
  }
  const nextStatus = normalizeUploadJobStatus(event.status);
  if (!nextStatus) return fail("INVALID_UPLOAD_STATUS", "上传任务状态无效");
  const id = getUploadJobDocumentId(actor, mutation.value);
  let nextItem = null;
  try {
    await withTransaction(async (transaction) => {
      const ref = transaction.collection(UPLOAD_JOB_COLLECTION).doc(id);
      const current = await getDocumentOrNull(UPLOAD_JOB_COLLECTION, id, transaction);
      if (!current) {
        const error = new Error("上传任务不存在或已移除");
        error.code = "UPLOAD_JOB_NOT_FOUND";
        throw error;
      }
      if (trimText(current.ownerUid) !== actor.id) {
        const error = new Error("只能更新自己创建的上传任务");
        error.code = "UPLOAD_JOB_FORBIDDEN";
        throw error;
      }
      if (current.tombstone === true || current.status === "removed") {
        const error = new Error("上传任务已被移除");
        error.code = "UPLOAD_JOB_REMOVED";
        throw error;
      }
      if (!isAllowedUploadStatusTransition(current.status, nextStatus)) {
        const error = new Error("上传任务状态变化无效，请刷新后重试");
        error.code = "INVALID_UPLOAD_STATUS_TRANSITION";
        throw error;
      }
      const patch = {
        status: nextStatus,
        updatedAt: db.serverDate(),
      };
      if (Object.prototype.hasOwnProperty.call(event, "title")) {
        patch.title = (trimText(event.title) || current.title || "未命名案例").slice(0, 120);
      }
      if (Object.prototype.hasOwnProperty.call(event, "caseId")) {
        patch.caseId = trimText(event.caseId).slice(0, 80);
      }
      if (Object.prototype.hasOwnProperty.call(event, "createdId")) {
        patch.caseDocumentId = trimText(event.createdId).slice(0, 120);
      }
      if (Object.prototype.hasOwnProperty.call(event, "error")) {
        patch.errorMessage = trimText(event.error).slice(0, 300);
      }
      await ref.update({ data: patch });
      nextItem = { ...current, ...patch, _id: id };
    }, { required: true });
  } catch (error) {
    if (error.code) return fail(error.code, error.message);
    throw error;
  }

  await writeAdminActivitySafe({
    action: getUploadActivityAction(nextStatus),
    targetType: "upload_job",
    targetId: id,
    title: nextItem.title,
    caseId: nextItem.caseId,
    batchId: nextItem.uploadBatchId,
    mutationId: nextItem.mutationId,
    status: nextStatus,
    imageCount: nextItem.imageCount,
  }, actor, `upload-status:${actor.id}:${mutation.value}:${nextStatus}`);
  return ok({ updated: 1, item: nextItem });
}

async function removeUploadItem(event, actor) {
  const actorError = requireWebActor(actor);
  if (actorError) return actorError;
  const mutation = normalizeClientMutationId(event.mutationId || event.clientMutationId);
  if (!mutation.valid || !mutation.value) {
    return failFromValidation(mutation.valid
      ? { code: "MUTATION_ID_REQUIRED", message: "缺少上传任务编号" }
      : mutation);
  }
  const id = getUploadJobDocumentId(actor, mutation.value);
  let removedItem = null;
  let removed = 0;
  try {
    await withTransaction(async (transaction) => {
      const ref = transaction.collection(UPLOAD_JOB_COLLECTION).doc(id);
      const current = await getDocumentOrNull(UPLOAD_JOB_COLLECTION, id, transaction);
      if (!current) {
        const data = {
          mutationId: mutation.value,
          ownerUid: actor.id,
          ownerActor: actor,
          ownerDisplayName: getAdminDisplayName(actor, process.env),
          title: "已移除的上传任务",
          imageCount: 0,
          status: "removed",
          tombstone: true,
          removedAt: db.serverDate(),
          createdAt: db.serverDate(),
          updatedAt: db.serverDate(),
        };
        removedItem = { ...data, _id: id };
        removed = 1;
        await ref.set({ data });
        return;
      }
      if (trimText(current.ownerUid) !== actor.id) {
        const error = new Error("只能移除自己创建的上传任务");
        error.code = "UPLOAD_JOB_FORBIDDEN";
        throw error;
      }
      if (current.tombstone === true || current.status === "removed") {
        removedItem = { ...current, _id: id };
        return;
      }
      if (!["waiting", "failed"].includes(current.status)) {
        const error = new Error("只能移除等待中或失败的上传任务");
        error.code = "UPLOAD_JOB_BUSY";
        throw error;
      }
      const tombstone = {
        ...current,
        status: "removed",
        tombstone: true,
        removedAt: db.serverDate(),
        updatedAt: db.serverDate(),
      };
      removedItem = { ...tombstone, _id: id };
      removed = 1;
      await ref.set({
        data: tombstone,
      });
    }, { required: true });
  } catch (error) {
    if (error.code) return fail(error.code, error.message);
    throw error;
  }
  await writeAdminActivitySafe({
    action: "upload_removed",
    targetType: "upload_job",
    targetId: id,
    title: removedItem.title,
    batchId: removedItem.uploadBatchId,
    mutationId: removedItem.mutationId,
    status: removedItem.status,
    imageCount: removedItem.imageCount,
  }, actor, `upload-remove:${actor.id}:${mutation.value}`);
  return ok({ removed, mutationId: mutation.value });
}

async function listSharedUploadItems(event, actor) {
  const actorError = requireWebActor(actor);
  if (actorError) return actorError;
  await repairAdminActivityOutboxesSafe();
  const limit = normalizeAdminListLimit(event.limit, ADMIN_RECORD_RETENTION_LIMIT);
  const items = [];
  let skip = 0;
  while (items.length < limit) {
    const response = await db.collection(UPLOAD_JOB_COLLECTION)
      .orderBy("updatedAt", "desc")
      .skip(skip)
      .limit(CASE_SCAN_BATCH_SIZE)
      .get();
    const batch = response.data || [];
    batch.forEach((item) => {
      if (
        items.length < limit
        && item.tombstone !== true
        && item.status !== "removed"
      ) items.push(item);
    });
    if (batch.length < CASE_SCAN_BATCH_SIZE || items.length >= limit) break;
    skip += batch.length;
  }
  return ok({
    items,
    limit,
  });
}

async function listAdminActivity(event, actor) {
  const actorError = requireWebActor(actor);
  if (actorError) return actorError;
  await repairAdminActivityOutboxesSafe();
  const limit = normalizeAdminListLimit(event.limit, ADMIN_RECORD_RETENTION_LIMIT);
  const response = await db
    .collection(ACTIVITY_FEED_COLLECTION)
    .where({ viewerUid: actor.id })
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  return ok({ items: response.data || [], limit });
}

async function completeUploadJobForCaseSafe(actor, mutationId, created, caseData) {
  if (!isActivitySyncEnabled() || !actor || actor.type !== "cloudbase_uid") return;
  const id = getUploadJobDocumentId(actor, mutationId);
  try {
    const current = await getDocumentOrNull(UPLOAD_JOB_COLLECTION, id);
    if (
      current
      && trimText(current.ownerUid) === actor.id
      && current.tombstone !== true
      && current.status !== "removed"
    ) {
      const status = caseData.packageTypes
        && Array.isArray(caseData.packageTypes.values)
        && caseData.packageTypes.values.length
        ? "done"
        : "needs_tags";
      await db.collection(UPLOAD_JOB_COLLECTION).doc(id).update({
        data: {
          status,
          caseId: created.caseId,
          caseDocumentId: created.id,
          updatedAt: db.serverDate(),
        },
      });
    }
    await writeAdminActivitySafe({
      action: "case_created",
      targetType: "case",
      targetId: created.id,
      title: caseData.title,
      caseId: created.caseId,
      mutationId,
      status: "done",
      imageCount: Array.isArray(caseData.galleryImages) ? caseData.galleryImages.length : 0,
    }, actor, `case-create:${created.id}:${created.version || 1}`);
  } catch (error) {
    console.warn("upload completion synchronization deferred", error);
  }
}

async function findCaseByMutationId(clientMutationId) {
  if (!clientMutationId) return null;
  const response = await db
    .collection(CASE_COLLECTION)
    .where({ clientMutationId })
    .limit(1)
    .get();
  return (response.data || [])[0] || null;
}

function getWebMutationDocumentId(actor, clientMutationId) {
  const digest = crypto
    .createHash("sha256")
    .update(`${actor.id}:${clientMutationId}`)
    .digest("hex")
    .slice(0, 40);
  return `admin_case_${digest}`;
}

function normalizeUploadBatchId(value, legacyMutationId, hasExplicitValue) {
  if (!hasExplicitValue) {
    return legacyMutationId
      ? { valid: true, value: legacyMutationId }
      : {
        valid: false,
        code: "UPLOAD_BATCH_ID_REQUIRED",
        message: "电脑后台创建案例必须携带上传批次编号",
        value: "",
      };
  }
  const uploadBatchId = trimText(value);
  if (!uploadBatchId) {
    return {
      valid: false,
      code: "INVALID_UPLOAD_BATCH_ID",
      message: "上传批次编号格式无效",
      value: "",
    };
  }
  if (
    uploadBatchId.length > 120 ||
    !/^[A-Za-z0-9._-]+$/.test(uploadBatchId)
  ) {
    return {
      valid: false,
      code: "INVALID_UPLOAD_BATCH_ID",
      message: "上传批次编号格式无效",
      value: "",
    };
  }
  return { valid: true, value: uploadBatchId };
}

function getWebUploadBatchClaimDocumentId(actor, uploadBatchId) {
  const digest = crypto
    .createHash("sha256")
    .update(`${actor.id}:${uploadBatchId}`)
    .digest("hex");
  return `upload_batch_${digest}`;
}

async function getCaseByDocumentId(id, source = db) {
  try {
    const response = await source.collection(CASE_COLLECTION).doc(id).get();
    return response.data || null;
  } catch (error) {
    if (isDocumentNotFoundError(error)) return null;
    throw error;
  }
}

async function createWebCaseAtomically({
  actor,
  clientMutationId,
  uploadBatchId,
  candidateData,
  fallbackNumber,
  preserveSortOrder,
}) {
  if (typeof db.runTransaction !== "function") {
    const error = new Error("当前数据库 SDK 不支持事务创建");
    error.code = "CASE_NUMBER_RESERVATION_FAILED";
    throw error;
  }
  const documentId = getWebMutationDocumentId(actor, clientMutationId);
  const uploadBatchClaimDocumentId = getWebUploadBatchClaimDocumentId(
    actor,
    uploadBatchId
  );
  let result = null;
  await db.runTransaction(async (transaction) => {
    const caseRef = transaction.collection(CASE_COLLECTION).doc(documentId);
    const existing = await getCaseByDocumentId(documentId, transaction);
    if (existing) {
      result = {
        id: documentId,
        caseId: existing.caseId,
        version: getRecordVersion(existing),
        duplicate: true,
        idempotentReplay: true,
      };
      return;
    }

    // The purge guard is read in the same transaction that writes the case.
    // If cleanup acquires the guard concurrently, CloudBase retries one side;
    // a retried create sees the active guard and cannot introduce a late ref.
    await assertNoActivePurgeCleanup(transaction);

    const metaRef = transaction
      .collection(CATALOG_META_COLLECTION)
      .doc(CATALOG_META_DOCUMENT_ID);
    const uploadBatchClaimRef = transaction
      .collection(CATALOG_META_COLLECTION)
      .doc(uploadBatchClaimDocumentId);
    let uploadBatchClaim = null;
    try {
      const response = await uploadBatchClaimRef.get();
      uploadBatchClaim = response.data || null;
    } catch (error) {
      if (!isDocumentNotFoundError(error)) throw error;
    }
    let meta = null;
    try {
      const response = await metaRef.get();
      meta = response.data || null;
    } catch (error) {
      if (!isDocumentNotFoundError(error)) throw error;
      meta = null;
    }
    const configured = Number(meta && meta.nextCaseNumber);
    const caseNumber = Number.isInteger(configured) && configured > 0
      ? Math.max(configured, fallbackNumber)
      : fallbackNumber;
    const caseId = `case_${String(caseNumber).padStart(3, "0")}`;
    const data = {
      ...candidateData,
      caseId,
      sortOrder: preserveSortOrder ? candidateData.sortOrder : caseNumber,
    };
    data.keywords = buildCaseKeywords(data);
    const metaData = {
      nextCaseNumber: caseNumber + 1,
      updatedAt: db.serverDate(),
    };
    if (!uploadBatchClaim) {
      metaData.revision = (Number(meta && meta.revision) || 0) + 1;
    }
    if (meta) {
      await metaRef.update({ data: metaData });
    } else {
      await metaRef.set({ data: { revision: 0, ...metaData } });
    }
    if (!uploadBatchClaim) {
      await uploadBatchClaimRef.set({
        data: {
          uploadBatchId,
          actorId: actor.id,
          createdAt: db.serverDate(),
        },
      });
    }
    await caseRef.set({
      data: {
        ...data,
        version: 1,
        clientMutationId,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
        ...actorAuditFields(actor, "created"),
        ...actorAuditFields(actor, "updated"),
      },
    });
    result = {
      id: documentId,
      caseId,
      version: 1,
      duplicate: false,
      idempotentReplay: false,
    };
  });
  return result;
}

async function createCase(event, actor) {
  const input = event.case || event.data || {};
  const isWebActor = actor && actor.type === "cloudbase_uid";
  const mutationResult = normalizeClientMutationId(
    event.clientMutationId || input.clientMutationId
  );
  if (!mutationResult.valid) return failFromValidation(mutationResult);
  if (isWebActor && !mutationResult.value) {
    return fail("MUTATION_ID_REQUIRED", "电脑后台创建案例必须携带任务编号");
  }
  const hasEventUploadBatchId = Object.prototype.hasOwnProperty.call(
    event,
    "uploadBatchId"
  );
  const hasInputUploadBatchId = Object.prototype.hasOwnProperty.call(
    input,
    "uploadBatchId"
  );
  const uploadBatchResult = isWebActor
    ? normalizeUploadBatchId(
      hasEventUploadBatchId ? event.uploadBatchId : input.uploadBatchId,
      mutationResult.value,
      hasEventUploadBatchId || hasInputUploadBatchId
    )
    : { valid: true, value: "" };
  if (!uploadBatchResult.valid) return failFromValidation(uploadBatchResult);
  if (isWebActor) {
    const documentId = getWebMutationDocumentId(actor, mutationResult.value);
    const existing = await getCaseByDocumentId(documentId);
    if (existing) {
      return ok({
        id: documentId,
        caseId: existing.caseId,
        version: getRecordVersion(existing),
        duplicate: true,
        idempotentReplay: true,
      });
    }
  } else {
    const existingMutation = await findCaseByMutationId(mutationResult.value);
    if (existingMutation) {
      return ok({
        id: existingMutation._id,
        caseId: existingMutation.caseId,
        version: getRecordVersion(existingMutation),
        duplicate: true,
        idempotentReplay: true,
      });
    }
  }

  if (isWebActor && trimText(input.caseId)) {
    return fail("CLIENT_CASE_ID_NOT_ALLOWED", "案例编号由服务端生成，请勿手动填写");
  }
  let defaults = {};
  if (!trimText(input.caseId)) {
    if (isWebActor) {
      const cases = await fetchAllCases({ field: { caseId: true } });
      const defaultCaseId = generateSequentialCaseId(cases);
      defaults = {
        defaultCaseId,
        defaultSortOrder: getCaseIdNumber(defaultCaseId),
      };
    } else {
      defaults = await getCreateCaseDefaults();
    }
  }
  const result = sanitizeCasePayload(input, {
    isCreate: true,
    allowIncompleteHidden: isWebActor,
    now: Date.now(),
    ...defaults,
  });
  if (!result.valid) return fail(result.code, result.message);
  const sourceValidation = validateWebSourceFiles(result.data.sourceGalleryImages, actor);
  if (!sourceValidation.valid) return failFromValidation(sourceValidation);
  const variantValidation = validateWebImageVariants(result.data, actor);
  if (!variantValidation.valid) return failFromValidation(variantValidation);
  if (variantValidation.introducedVariants) {
    result.data.imageVariantVersion = 2;
  }
  const readyValidation = validateCaseReadyForVisibility(result.data);
  if (!readyValidation.valid) return failFromValidation(readyValidation);
  const pinnedError = await validatePinnedCapacity(result.data.isPinned);
  if (pinnedError) return pinnedError;
  const homepageError = await validateHomepageCapacity(
    result.data,
    getActivatedHomepageSlots(null, result.data)
  );
  if (homepageError) return homepageError;

  if (isWebActor) {
    try {
      const atomicResult = await createWebCaseAtomically({
        actor,
        clientMutationId: mutationResult.value,
        uploadBatchId: uploadBatchResult.value,
        candidateData: result.data,
        fallbackNumber: getCaseIdNumber(defaults.defaultCaseId),
        preserveSortOrder: Object.prototype.hasOwnProperty.call(input, "sortOrder"),
      });
      if (!atomicResult.idempotentReplay) {
        await completeUploadJobForCaseSafe(
          actor,
          mutationResult.value,
          atomicResult,
          result.data
        );
      }
      return ok(atomicResult);
    } catch (error) {
      console.error("atomic web case create error", error);
      return fail(
        error.code || "CASE_NUMBER_RESERVATION_FAILED",
        "案例创建事务失败，请稍后重试"
      );
    }
  }

  let response;
  try {
    await withTransaction(async (transaction) => {
      await assertNoActivePurgeCleanup(transaction);
      response = await transaction.collection(CASE_COLLECTION).add({
        data: {
          ...result.data,
          version: 1,
          ...(mutationResult.value ? { clientMutationId: mutationResult.value } : {}),
          createdAt: db.serverDate(),
          updatedAt: db.serverDate(),
          ...actorAuditFields(actor, "created"),
          ...actorAuditFields(actor, "updated"),
        },
      });
    }, { required: true });
  } catch (error) {
    return fail(
      error.code || "TRANSACTION_FAILED",
      error.message || "案例创建事务失败，请稍后重试"
    );
  }
  await bumpCatalogRevision();

  await writeAdminActivitySafe({
    action: "case_created",
    targetType: "case",
    targetId: response._id,
    title: result.data.title,
    caseId: result.data.caseId,
    mutationId: mutationResult.value,
    status: "done",
    imageCount: Array.isArray(result.data.galleryImages)
      ? result.data.galleryImages.length
      : 0,
  }, actor, `case-create:${response._id}:1`);

  return ok({
    id: response._id,
    caseId: result.data.caseId,
    version: 1,
  });
}

async function updateCase(event, actor) {
  const id = trimText(event.id);
  if (!id) return fail("INVALID_ID", "缺少案例 ID");

  const existing = await getCaseById(id);
  if (!existing) return fail("CASE_NOT_FOUND", "案例不存在或已删除");
  if (existing.deletedAt) return fail("CASE_IN_TRASH", "回收站中的案例不能编辑");
  const mutationResult = normalizeClientMutationId(
    event.clientMutationId || (event.case && event.case.clientMutationId)
  );
  if (!mutationResult.valid) return failFromValidation(mutationResult);
  if (mutationResult.value && existing.clientMutationId === mutationResult.value) {
    return ok({ id, version: getRecordVersion(existing), idempotentReplay: true });
  }
  const videoPatch = sanitizeVideoPatch(event.videoPatch);
  if (!videoPatch.valid) return failFromValidation(videoPatch);
  const versionValidation = validateExpectedVersion(existing, event.expectedVersion, {
    required: Boolean(
      (actor && actor.type === "cloudbase_uid") || !videoPatch.omitted
    ),
  });
  if (!versionValidation.valid) return failFromValidation(versionValidation);
  const input = event.case || event.data || {};
  const result = sanitizeCasePayload(input, {
    isCreate: false,
    allowIncompleteHidden: actor && actor.type === "cloudbase_uid",
  });
  if (!result.valid) return fail(result.code, result.message);
  const preparedVideoIntents = [];
  if (!videoPatch.omitted) {
    if (videoPatch.mode === "upload") {
      const uploadedFiles = getIntroducedVideoUploadFiles(videoPatch, existing);
      if (uploadedFiles.length && !isVideoUploadEnabled()) {
        return fail("VIDEO_UPLOAD_DISABLED", "视频上传功能尚未开启");
      }
      for (const uploadedFile of uploadedFiles) {
        const intentValidation = await validatePreparedVideoIntent(
          uploadedFile.fileID,
          actor,
          id,
          uploadedFile.kind
        );
        if (!intentValidation.valid) return failFromValidation(intentValidation);
        if (await isVideoFileReferencedByOtherCase(uploadedFile.fileID, id)) {
          return fail(
            "VIDEO_FILE_ALREADY_REFERENCED",
            "该云存储文件已被其他案例使用"
          );
        }
        const metadata = await inspectVideoStorageFile(
          uploadedFile.fileID,
          uploadedFile.kind
        );
        if (!metadata.valid) return failFromValidation(metadata);
        preparedVideoIntents.push({
          ...uploadedFile,
          uploadId: intentValidation.uploadId,
          metadata,
        });
      }
      const videoMetadata = preparedVideoIntents.find((item) => item.kind === "video");
      videoPatch.data.videoFileSizeBytes = videoMetadata
        ? videoMetadata.metadata.size
        : normalizeStoredVideoFileSize(existing.videoFileSizeBytes);
    }
    Object.assign(result.data, videoPatch.data);
  }
  if (Object.prototype.hasOwnProperty.call(result.data, "sourceGalleryImages")) {
    const existingSources = new Set(normalizeCloudFileIds(
      existing.sourceGalleryImages || [],
      CASE_GALLERY_MAX
    ));
    const addedSources = result.data.sourceGalleryImages.filter(
      (fileID) => !existingSources.has(fileID)
    );
    if (addedSources.length) {
      const sourceValidation = validateWebSourceFiles(addedSources, actor);
      if (!sourceValidation.valid) return failFromValidation(sourceValidation);
    }
  }
  const nextPinned = Object.prototype.hasOwnProperty.call(result.data, "isPinned")
    ? result.data.isPinned
    : existing.isPinned === true;
  const pinnedError = await validatePinnedCapacity(nextPinned, id);
  if (pinnedError) return pinnedError;
  const nextCase = {
    ...existing,
    ...result.data,
    _id: id,
  };
  if (Object.prototype.hasOwnProperty.call(result.data, "homeSections")) {
    const activeSlots = new Set(result.data.homeSections.values || []);
    const candidateOrders = result.data.homeSectionOrder || existing.homeSectionOrder || {};
    result.data.homeSectionOrder = Object.keys(candidateOrders).reduce(
      (orders, slot) => {
        if (activeSlots.has(slot)) orders[slot] = candidateOrders[slot];
        return orders;
      },
      {}
    );
    nextCase.homeSectionOrder = result.data.homeSectionOrder;
  }
  const imageChanges = hasCaseImageChanges(existing, result.data);
  if (imageChanges) {
    const variantValidation = validateWebImageVariants(nextCase, actor, { existing });
    if (!variantValidation.valid) return failFromValidation(variantValidation);
    if (variantValidation.introducedVariants) {
      result.data.imageVariantVersion = 2;
      nextCase.imageVariantVersion = 2;
    }
  }
  result.data.keywords = buildCaseKeywords(nextCase);
  nextCase.keywords = result.data.keywords;
  const readyValidation = validateCaseReadyForVisibility(nextCase);
  if (!readyValidation.valid) return failFromValidation(readyValidation);
  const homepageError = await validateHomepageCapacity(
    nextCase,
    getActivatedHomepageSlots(existing, nextCase),
    id
  );
  if (homepageError) return homepageError;

  let nextVersion = getRecordVersion(existing) + 1;
  let committedBase = existing;
  try {
    await withTransaction(async (transaction) => {
      const ref = transaction.collection(CASE_COLLECTION).doc(id);
      const currentResponse = await ref.get();
      const current = currentResponse.data;
      committedBase = current;
      const currentValidation = validateExpectedVersion(current, event.expectedVersion, {
        required: Boolean(
          (actor && actor.type === "cloudbase_uid") || !videoPatch.omitted
        ),
      });
      if (!currentValidation.valid) {
        const error = new Error(currentValidation.message);
        Object.assign(error, currentValidation);
        throw error;
      }
      const transactionPreparedVideoIntents = [];
      if (videoPatch.mode === "upload") {
        const introducedFiles = getIntroducedVideoUploadFiles(videoPatch, current);
        for (const introducedFile of introducedFiles) {
          const preparedIntent = preparedVideoIntents.find(
            (item) => item.kind === introducedFile.kind
              && item.fileID === introducedFile.fileID
          );
          // expectedVersion makes `existing` and `current` the same revision.
          // Fail closed if out-of-band data changed without advancing it.
          if (!preparedIntent) {
            const error = new Error("案例已被其他管理员修改，请刷新后重试");
            error.code = "VERSION_CONFLICT";
            error.currentVersion = getRecordVersion(current);
            throw error;
          }
          const revalidated = await validatePreparedVideoIntent(
            introducedFile.fileID,
            actor,
            id,
            introducedFile.kind,
            transaction
          );
          if (!revalidated.valid) {
            const error = new Error(revalidated.message);
            Object.assign(error, revalidated);
            throw error;
          }
          transactionPreparedVideoIntents.push(preparedIntent);
        }
        const introducedVideo = transactionPreparedVideoIntents.find(
          (item) => item.kind === "video"
        );
        result.data.videoFileSizeBytes = introducedVideo
          ? introducedVideo.metadata.size
          : normalizeStoredVideoFileSize(current.videoFileSizeBytes);
      }
      const currentImageChanges = hasCaseImageChanges(current, result.data);
      const currentVideoChanges = hasCaseVideoChanges(current, result.data);
      // This is the final transactional read (and can fence an expired guard).
      // No case or upload-intent write may happen before it completes.
      if (currentImageChanges || currentVideoChanges) {
        await assertNoActivePurgeCleanup(transaction);
      }
      nextVersion = getRecordVersion(current) + 1;
      await ref.update({
        data: {
          ...result.data,
          ...(mutationResult.value ? { clientMutationId: mutationResult.value } : {}),
          version: nextVersion,
          updatedAt: db.serverDate(),
          ...actorAuditFields(actor, "updated"),
        },
      });
      for (const preparedIntent of transactionPreparedVideoIntents) {
        await transaction
          .collection(VIDEO_UPLOAD_INTENT_COLLECTION)
          .doc(preparedIntent.uploadId)
          .update({
            data: {
              status: "consumed",
              consumedAt: db.serverDate(),
              consumedByCaseId: id,
              updatedAt: db.serverDate(),
            },
          });
      }
    }, { required: true });
  } catch (error) {
    if (error.code) return failFromValidation(error);
    throw error;
  }
  const nextFileIds = new Set(getCaseImageFileIds({ ...committedBase, ...result.data }));
  const sourceFileIds = new Set(getCaseSourceFileIds(committedBase));
  const removedFileIds = getCaseImageFileIds(committedBase).filter(
    (fileID) => !nextFileIds.has(fileID) && !sourceFileIds.has(fileID)
  );
  const nextVideoFileIds = new Set(getCaseVideoFileIds({
    ...committedBase,
    ...result.data,
  }));
  const removedVideoFileIds = getCaseVideoFileIds(committedBase).filter(
    (fileID) => !nextVideoFileIds.has(fileID) && isAllowedPurgeFile(fileID)
  );
  await deleteUnreferencedCaseFiles([...removedFileIds, ...removedVideoFileIds]);
  await bumpCatalogRevision();
  const refreshed = await getCase({ id });
  return ok({ id, version: nextVersion, item: refreshed.item });
}

async function setCaseVisibility(event, actor) {
  const result = await updateCase({
    ...event,
    case: { isVisible: event.isVisible === true },
  }, actor);
  return result.ok
    ? { ...result, isVisible: event.isVisible === true }
    : result;
}

function getCaseImageFileIds(item = {}) {
  return Array.from(new Set([
    trimText(item.coverImage),
    trimText(item.coverThumbnail),
    trimText(item.coverBanner),
    ...normalizeCloudFileIds(item.galleryImages || [], CASE_GALLERY_MAX),
    ...normalizeCloudFileIds(item.sourceGalleryImages || [], CASE_GALLERY_MAX),
    ...normalizeCloudFileIds(item.galleryThumbnails || [], CASE_GALLERY_MAX),
    ...normalizeCloudFileIds(item.galleryBanners || [], CASE_GALLERY_MAX),
  ].filter((fileID) => fileID.indexOf("cloud://") === 0)));
}

function getCaseSourceFileIds(item = {}) {
  const explicitSources = normalizeCloudFileIds(
    item.sourceGalleryImages || [],
    CASE_GALLERY_MAX
  );
  if (explicitSources.length) return explicitSources;
  return Array.from(new Set([
    trimText(item.coverImage),
    ...normalizeCloudFileIds(item.galleryImages || [], CASE_GALLERY_MAX),
  ].filter((fileID) => fileID.indexOf("cloud://") === 0)));
}

async function isCaseImageReferenced(fileID) {
  if (!fileID || fileID.indexOf("cloud://") !== 0) return false;

  const [
    coverResponse,
    thumbnailResponse,
    galleryResponse,
    sourceGalleryResponse,
    galleryThumbnailResponse,
    coverBannerResponse,
    galleryBannerResponse,
    videoResponse,
    videoPosterResponse,
    bannerResponse,
    optimizedBannerResponse,
  ] = await Promise.all([
    db
      .collection(CASE_COLLECTION)
      .where({ coverImage: fileID })
      .field({ _id: true })
      .limit(1)
      .get(),
    db
      .collection(CASE_COLLECTION)
      .where({ coverThumbnail: fileID })
      .field({ _id: true })
      .limit(1)
      .get(),
    db
      .collection(CASE_COLLECTION)
      .where({ galleryImages: _.in([fileID]) })
      .field({ _id: true })
      .limit(1)
      .get(),
    db
      .collection(CASE_COLLECTION)
      .where({ sourceGalleryImages: _.in([fileID]) })
      .field({ _id: true })
      .limit(1)
      .get(),
    db
      .collection(CASE_COLLECTION)
      .where({ galleryThumbnails: _.in([fileID]) })
      .field({ _id: true })
      .limit(1)
      .get(),
    db
      .collection(CASE_COLLECTION)
      .where({ coverBanner: fileID })
      .field({ _id: true })
      .limit(1)
      .get(),
    db
      .collection(CASE_COLLECTION)
      .where({ galleryBanners: _.in([fileID]) })
      .field({ _id: true })
      .limit(1)
      .get(),
    db
      .collection(CASE_COLLECTION)
      .where({ videoFileID: fileID })
      .field({ _id: true })
      .limit(1)
      .get(),
    db
      .collection(CASE_COLLECTION)
      .where({ videoPosterFileID: fileID })
      .field({ _id: true })
      .limit(1)
      .get(),
    db
      .collection(BANNER_COLLECTION)
      .where({ image: fileID })
      .field({ _id: true })
      .limit(1)
      .get(),
    db
      .collection(BANNER_COLLECTION)
      .where({ optimizedImage: fileID })
      .field({ _id: true })
      .limit(1)
      .get(),
  ]);

  return Boolean(
      (coverResponse.data || []).length ||
      (thumbnailResponse.data || []).length ||
      (galleryResponse.data || []).length ||
      (sourceGalleryResponse.data || []).length ||
      (galleryThumbnailResponse.data || []).length ||
      (coverBannerResponse.data || []).length ||
      (galleryBannerResponse.data || []).length ||
      (videoResponse.data || []).length ||
      (videoPosterResponse.data || []).length ||
      (bannerResponse.data || []).length ||
      (optimizedBannerResponse.data || []).length
  );
}

async function deleteUnreferencedCaseFilesDetailed(fileIDs = []) {
  const deletedFileIds = [];
  const skippedFileIds = [];
  const failedFileIds = [];
  for (const fileID of Array.from(new Set(fileIDs.filter((value) => value.indexOf("cloud://") === 0)))) {
    if (await isCaseImageReferenced(fileID)) {
      skippedFileIds.push(fileID);
      continue;
    }
    try {
      const response = await cloud.deleteFile({ fileList: [fileID] });
      const classified = classifyDeleteFileResponse([fileID], response);
      if (classified.deleted.includes(fileID)) {
        deletedFileIds.push(fileID);
        continue;
      }
      failedFileIds.push(fileID);
      console.warn("case file cleanup failed", {
        stage: "delete_unreferenced_file",
        errorCode: classified.ambiguous
          ? "STORAGE_DELETE_AMBIGUOUS"
          : "STORAGE_DELETE_REJECTED",
      });
    } catch (error) {
      failedFileIds.push(fileID);
      console.warn("case file cleanup failed", {
        stage: "delete_unreferenced_file",
        errorCode: normalizeLogErrorCode(error, "STORAGE_DELETE_FAILED"),
      });
    }
  }
  return { deletedFileIds, skippedFileIds, failedFileIds };
}

async function deleteUnreferencedCaseFiles(fileIDs = []) {
  const result = await deleteUnreferencedCaseFilesDetailed(fileIDs);
  return result.deletedFileIds;
}

function isAllowedCleanupFile(fileID, actor) {
  const path = getCloudFilePath(fileID);
  const isVariant = /^wine-packaging\/variants\/v2\/[a-f0-9]{32}\/(?:display|thumbnail|banner)\.jpg$/i.test(path);
  const isPreparedVideo = isCloudFileFromEnvironment(
    fileID,
    getRuntimeCloudEnvironment()
  ) && isVideoUploadFileForActor(fileID, actor);
  if (actor && actor.type === "cloudbase_uid") {
    return isVariant || isWebAdminUploadFile(fileID, actor.id) || isPreparedVideo;
  }
  return isVariant
    || isPreparedVideo
    || /^wine-packaging\/admin\/[^/]+\.(?:jpe?g|png|webp)$/i.test(path);
}

function isAllowedPurgeFile(fileID) {
  const path = getCloudFilePath(fileID);
  if (!isCloudFileFromEnvironment(fileID, getRuntimeCloudEnvironment())) return false;
  return (
    /^wine-packaging\/(?:admin|cases)\/[^/]+\.(?:jpe?g|png|webp)$/i.test(path)
    || /^wine-packaging\/admin-web\/[^/]+\/[^/]+\/[^/]+\.(?:jpe?g|png|webp)$/i.test(path)
    || /^wine-packaging\/variants\/v2\/[a-f0-9]{32}\/(?:display|thumbnail|banner)\.jpg$/i.test(path)
    || new RegExp(`^${VIDEO_UPLOAD_PREFIX}/[a-f0-9]{24}/[a-f0-9]{24}/(?:[a-f0-9]{32}\\.mp4|posters/[a-f0-9]{32}\\.(?:jpe?g|png|webp))$`, "i").test(path)
  );
}

function getPreparedVideoFileKind(fileID) {
  const path = getCloudFilePath(fileID);
  if (/\/posters\/[a-f0-9]{32}\.(?:jpe?g|png|webp)$/i.test(path)) return "poster";
  if (/[a-f0-9]{32}\.mp4$/i.test(path)) return "video";
  return "";
}

async function claimPreparedVideoCleanup(fileID, actor) {
  const uploadId = getPreparedVideoUploadId(fileID);
  const kind = getPreparedVideoFileKind(fileID);
  if (!uploadId || !kind) return { claimed: false };
  let claimed = false;
  await withTransaction(async (transaction) => {
    // CloudBase may retry this callback after a write conflict.
    claimed = false;
    const ref = transaction.collection(VIDEO_UPLOAD_INTENT_COLLECTION).doc(uploadId);
    const intent = await getDocumentOrNull(
      VIDEO_UPLOAD_INTENT_COLLECTION,
      uploadId,
      transaction
    );
    if (
      !intent
      || !sameAdminActor(intent.actor, actor)
      || trimText(intent.kind) !== kind
      || trimText(intent.cloudPath) !== getCloudFilePath(fileID)
      || !isPreparedVideoUploadFile(
        fileID,
        actor,
        intent.caseDocumentId,
        kind
      )
    ) {
      return;
    }
    const status = trimText(intent.status).toLowerCase();
    if (status === "cleanup_claimed") {
      // A failed or interrupted storage delete is safe for the same actor to retry.
      claimed = true;
      return;
    }
    if (status !== "prepared" || intent.consumedAt) return;
    claimed = true;
    // This transaction reads the intent before writing its cleanup claim.
    // updateCase consumes the same document, so only one operation can commit.
    await ref.update({
      data: {
        status: "cleanup_claimed",
        cleanupClaimedAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });
  }, { required: true });
  return { claimed };
}

async function cleanupUnreferencedFiles(event, actor) {
  const fileIDs = normalizeCloudFileIds(event.fileIDs || event.fileIds);
  if (!fileIDs.length) {
    return ok({ deletedFileIds: [], skippedFileIds: [], failedFileIds: [] });
  }
  if (fileIDs.some((fileID) => !isAllowedCleanupFile(fileID, actor))) {
    return fail(
      "INVALID_CLEANUP_PATH",
      "只能清理当前管理员的案例上传文件"
    );
  }
  const regularFileIds = [];
  const claimedVideoFileIds = [];
  const skippedFileIds = [];
  for (const fileID of fileIDs) {
    if (!isVideoUploadFileForActor(fileID, actor)) {
      regularFileIds.push(fileID);
      continue;
    }
    const claim = await claimPreparedVideoCleanup(fileID, actor);
    if (claim.claimed) claimedVideoFileIds.push(fileID);
    else skippedFileIds.push(fileID);
  }
  const cleanupResult = await deleteUnreferencedCaseFilesDetailed([
    ...regularFileIds,
    ...claimedVideoFileIds,
  ]);
  return ok({
    deletedFileIds: cleanupResult.deletedFileIds,
    skippedFileIds: Array.from(new Set([
      ...skippedFileIds,
      ...cleanupResult.skippedFileIds,
    ])),
    failedFileIds: cleanupResult.failedFileIds,
  });
}

async function scanCollectionByStableId(collectionName) {
  const items = [];
  let cursor = "";
  while (true) {
    let query = db.collection(collectionName);
    if (cursor) query = query.where({ _id: _.gt(cursor) });
    const response = await query
      .orderBy("_id", "asc")
      .limit(CASE_SCAN_BATCH_SIZE)
      .get();
    const batch = response.data || [];
    items.push(...batch);
    if (batch.length < CASE_SCAN_BATCH_SIZE) break;
    const nextCursor = trimText(batch[batch.length - 1] && batch[batch.length - 1]._id);
    if (!nextCursor || nextCursor <= cursor) {
      const error = new Error("图片引用扫描游标没有前进");
      error.code = "REFERENCE_SCAN_FAILED";
      throw error;
    }
    cursor = nextCursor;
  }
  return items;
}

async function getRemainingImageReferenceSet() {
  const [cases, banners] = await Promise.all([
    scanCollectionByStableId(CASE_COLLECTION),
    scanCollectionByStableId(BANNER_COLLECTION),
  ]);
  const references = new Set(cases.flatMap((item) => [
    ...getCaseImageFileIds(item),
    ...getCaseVideoFileIds(item),
  ]));
  banners.forEach((item) => {
    [trimText(item.image), trimText(item.optimizedImage)].forEach((fileID) => {
      if (fileID.indexOf("cloud://") === 0) references.add(fileID);
    });
  });
  return references;
}

function isStorageFileMissing(value) {
  const code = trimText(value && (value.code || value.errCode || value.status)).toUpperCase();
  const message = trimText(value && (value.message || value.errMsg));
  return (
    code.includes("NOT_FOUND")
    || code === "-503003"
    || /(?:file|object|resource).*(?:not found|does not exist)/i.test(message)
    || /文件.*不存在/.test(message)
  );
}

function classifyDeleteFileResponse(requestedFileIds, response) {
  const rows = response && Array.isArray(response.fileList) ? response.fileList : [];
  if (!rows.length || rows.every((item) => typeof item === "string")) {
    return { deleted: [], pending: requestedFileIds.slice(), ambiguous: true };
  }
  const byId = new Map(rows.map((item) => [trimText(item && item.fileID), item]));
  const deleted = [];
  const pending = [];
  let ambiguous = false;
  requestedFileIds.forEach((fileID) => {
    const item = byId.get(fileID);
    const status = item && item.status;
    if (!item) {
      pending.push(fileID);
      ambiguous = true;
    } else if (
      status === 0
      || status === "0"
      || status === "success"
      || isStorageFileMissing(item)
    ) {
      deleted.push(fileID);
    } else pending.push(fileID);
  });
  return { deleted, pending, ambiguous };
}

async function deletePurgeFileBatches(fileIDs, jobId, runToken) {
  const deleted = [];
  const pending = [];
  let keepGuardActive = false;
  for (let offset = 0; offset < fileIDs.length; offset += IMAGE_URL_BATCH_SIZE) {
    const batch = fileIDs.slice(offset, offset + IMAGE_URL_BATCH_SIZE);
    // Fence every destructive batch. If another invocation has taken over an
    // expired lease, this run stops before issuing another storage request.
    await renewPurgeGuardLease(jobId, runToken);
    try {
      const response = await deletePurgeFileBatchWithTimeout(batch);
      const classified = classifyDeleteFileResponse(batch, response);
      deleted.push(...classified.deleted);
      pending.push(...classified.pending);
      if (classified.ambiguous) {
        pending.push(...fileIDs.slice(offset + batch.length));
        keepGuardActive = true;
        break;
      }
    } catch (error) {
      // A thrown request can mean CloudBase accepted the deletion but the
      // response was lost. Its result is therefore ambiguous even for a
      // not-found-looking transport error. Keep the guard until lease expiry
      // so an in-flight request cannot race a newly saved image reference.
      pending.push(...fileIDs.slice(offset));
      keepGuardActive = true;
      break;
    }
  }
  return { deleted, pending, keepGuardActive };
}

function deletePurgeFileBatchWithTimeout(fileList) {
  let timeoutId = null;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error("云存储删除请求超时，已保留清理锁等待安全重试");
      error.code = "PURGE_DELETE_TIMEOUT";
      reject(error);
    }, PURGE_DELETE_CALL_TIMEOUT_MS);
  });
  return Promise.race([
    Promise.resolve().then(() => cloud.deleteFile({ fileList })),
    timeout,
  ]).finally(() => {
    if (timeoutId !== null) clearTimeout(timeoutId);
  });
}

function buildPurgeCleanupResult(job, overrides = {}) {
  const pendingFileIds = Array.isArray(job.pendingFileIds)
    ? job.pendingFileIds
    : (job.candidateFileIds || []);
  return {
    deleted: Number(job.deletedCaseCount) || 0,
    cleanupJobId: job._id,
    deletedFileCount: Array.isArray(job.deletedFileIds)
      ? job.deletedFileIds.length
      : 0,
    retainedReferencedCount: Array.isArray(job.retainedReferencedFileIds)
      ? job.retainedReferencedFileIds.length
      : 0,
    pendingFileCount: pendingFileIds.length,
    status: trimText(job.status) || "cleanup_pending",
    ...overrides,
  };
}

async function markPurgeGuardReleasePending(job, cleanupResult, releaseError) {
  try {
    await db.collection(PURGE_JOB_COLLECTION).doc(job._id).update({
      data: {
        status: "cleanup_release_pending",
        guardReleasePending: true,
        cleanupResultStatus: trimText(cleanupResult && cleanupResult.status),
        cleanupUpdatedAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });
  } catch (error) {
    // Keep the guard active and fail closed. The caller still receives the job
    // id and a non-zero pending count so the browser retains its retry record.
    console.warn("purge release-pending job update failed", error);
  }
  if (releaseError) console.warn("purge guard release deferred", releaseError);
  return {
    ...buildPurgeCleanupResult(job),
    ...(cleanupResult || {}),
    pendingFileCount: Math.max(
      1,
      Number(cleanupResult && cleanupResult.pendingFileCount) || 0
    ),
    status: "cleanup_release_pending",
    cleanupDeferred: true,
    guardReleasePending: true,
  };
}

async function runPurgeCleanup(job) {
  const runToken = getPurgeRunToken();
  await acquirePurgeGuard(job._id, runToken);
  let cleanupResult = null;
  let cleanupError = null;
  let keepGuardActive = false;
  try {
    const existingDeleted = new Set(job.deletedFileIds || []);
    const existingRetained = new Set(job.retainedReferencedFileIds || []);
    const candidates = Array.isArray(job.pendingFileIds) && job.pendingFileIds.length
      ? job.pendingFileIds
      : (job.candidateFileIds || []).filter(
        (fileID) => !existingDeleted.has(fileID) && !existingRetained.has(fileID)
      );
    const allowedCandidates = candidates.filter(isAllowedPurgeFile);
    candidates
      .filter((fileID) => !isAllowedPurgeFile(fileID))
      .forEach((fileID) => existingRetained.add(fileID));

    // First pass identifies likely references. The second stable-cursor pass
    // happens while the global purge guard blocks case image writes and is the
    // authoritative check immediately before the storage deletion.
    const initialReferences = await getRemainingImageReferenceSet();
    const initiallyDeletable = allowedCandidates.filter(
      (fileID) => !initialReferences.has(fileID)
    );
    const finalReferences = await getRemainingImageReferenceSet();
    const retainedNow = allowedCandidates.filter(
      (fileID) => initialReferences.has(fileID) || finalReferences.has(fileID)
    );
    const deletable = initiallyDeletable.filter(
      (fileID) => !finalReferences.has(fileID)
    );
    const cleanup = await deletePurgeFileBatches(deletable, job._id, runToken);
    keepGuardActive = cleanup.keepGuardActive === true;
    cleanup.deleted.forEach((fileID) => existingDeleted.add(fileID));
    retainedNow.forEach((fileID) => existingRetained.add(fileID));
    const pending = Array.from(new Set(cleanup.pending));
    const status = pending.length
      ? "cleanup_pending"
      : existingRetained.size
        ? "completed_with_references"
        : "completed";
    await db.collection(PURGE_JOB_COLLECTION).doc(job._id).update({
      data: {
        deletedFileIds: Array.from(existingDeleted),
        retainedReferencedFileIds: Array.from(existingRetained),
        pendingFileIds: pending,
        status,
        guardReleasePending: false,
        cleanupResultStatus: status,
        cleanupUpdatedAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });
    cleanupResult = {
      deleted: Number(job.deletedCaseCount) || 0,
      cleanupJobId: job._id,
      deletedFileCount: existingDeleted.size,
      retainedReferencedCount: existingRetained.size,
      pendingFileCount: pending.length,
      status,
    };
  } catch (error) {
    cleanupError = error;
  }

  if (keepGuardActive) {
    return markPurgeGuardReleasePending(
      job,
      cleanupResult,
      new Error("云存储删除请求结果未知，清理锁将保留至租约安全到期")
    );
  }

  let released = false;
  let releaseError = null;
  try {
    released = await releasePurgeGuard(job._id, runToken);
  } catch (error) {
    releaseError = error;
  }
  if (!released || releaseError) {
    return markPurgeGuardReleasePending(
      job,
      cleanupResult,
      releaseError || new Error("永久删除清理锁已由其他运行持有")
    );
  }
  if (cleanupError) throw cleanupError;
  return cleanupResult;
}

async function permanentlyDeleteCases(event, actor) {
  const actorError = requireWebActor(actor);
  if (actorError) return actorError;
  const idsResult = normalizeCaseIds(event.ids);
  if (!idsResult.valid) return failFromValidation(idsResult);
  const mutation = normalizeClientMutationId(event.clientMutationId);
  if (!mutation.valid || !mutation.value) {
    return failFromValidation(mutation.valid
      ? { code: "MUTATION_ID_REQUIRED", message: "永久删除必须携带幂等任务编号" }
      : mutation);
  }
  const jobId = getPurgeJobDocumentId(actor, mutation.value);
  let job = await getDocumentOrNull(PURGE_JOB_COLLECTION, jobId);
  let created = false;

  if (!job) {
    try {
      await withTransaction(async (transaction) => {
        const jobRef = transaction.collection(PURGE_JOB_COLLECTION).doc(jobId);
        const replay = await getDocumentOrNull(PURGE_JOB_COLLECTION, jobId, transaction);
        if (replay) {
          job = { ...replay, _id: jobId };
          return;
        }
        const guard = await getPurgeGuard(transaction);
        if (
          guard
          && guard.status === "active"
          && trimText(guard.activeJobId)
          && !isPurgeGuardLeaseExpired(guard)
        ) {
          const error = new Error("另一个永久删除任务正在清理图片，请稍后重试");
          error.code = "PURGE_CLEANUP_BUSY";
          throw error;
        }

        const rows = [];
        for (const id of idsResult.ids) {
          const ref = transaction.collection(CASE_COLLECTION).doc(id);
          const item = await getDocumentOrNull(CASE_COLLECTION, id, transaction);
          rows.push({ id, ref, item });
        }
        const missing = rows.filter((row) => !row.item).map((row) => row.id);
        if (missing.length) {
          const error = new Error(`以下案例不存在或已删除：${missing.join("、")}`);
          error.code = "CASE_NOT_FOUND";
          throw error;
        }
        if (rows.some((row) => !row.item.deletedAt)) {
          const error = new Error("只能永久删除回收站中的案例");
          error.code = "CASE_NOT_IN_TRASH";
          throw error;
        }
        for (const row of rows) {
          const validation = validateExpectedVersion(
            row.item,
            getExpectedVersion(event, row.id),
            { required: true }
          );
          if (!validation.valid) {
            const error = new Error(validation.message);
            Object.assign(error, validation, { id: row.id });
            throw error;
          }
        }

        const candidateFileIds = Array.from(new Set(
          rows.flatMap((row) => [
            ...getCaseImageFileIds(row.item),
            ...getCaseVideoFileIds(row.item),
          ])
        ));
        const caseSummaries = rows.map((row) => ({
          id: row.id,
          title: trimText(row.item.title).slice(0, 120),
          caseId: trimText(row.item.caseId).slice(0, 80),
          version: getRecordVersion(row.item),
        }));
        const data = {
          clientMutationId: mutation.value,
          actor,
          actorDisplayName: getAdminDisplayName(actor, process.env),
          deletedCaseCount: rows.length,
          caseSummaries,
          candidateFileIds,
          deletedFileIds: [],
          retainedReferencedFileIds: [],
          pendingFileIds: candidateFileIds,
          status: "cleanup_pending",
          createdAt: db.serverDate(),
          updatedAt: db.serverDate(),
        };
        // All validation reads finish before the first write so a rejected
        // batch cannot partially remove case documents.
        await jobRef.set({ data });
        for (const row of rows) await row.ref.remove();
        job = { ...data, _id: jobId };
        created = true;
      }, { required: true });
    } catch (error) {
      if (error.code) return failFromValidation(error);
      throw error;
    }
  }

  if (!job) return fail("PURGE_JOB_NOT_FOUND", "永久删除任务不存在");
  if (created) {
    await bumpCatalogRevision();
    await Promise.all((job.caseSummaries || []).map((item) => writeAdminActivitySafe({
      action: "case_permanently_deleted",
      targetType: "case",
      targetId: item.id,
      title: item.title,
      caseId: item.caseId,
    }, actor, `case-purge:${jobId}:${item.id}`)));
  }
  try {
    return ok(await runPurgeCleanup(job));
  } catch (error) {
    if (error.code === "PURGE_CLEANUP_BUSY") {
      return {
        ...failFromValidation(error),
        ...buildPurgeCleanupResult(job),
      };
    }
    // The database deletion is already committed. Report a retryable cleanup
    // result instead of making the client believe that the cases still exist.
    console.warn("purge cleanup deferred", error);
    return ok({
      deleted: Number(job.deletedCaseCount) || 0,
      cleanupJobId: job._id,
      deletedFileCount: Array.isArray(job.deletedFileIds) ? job.deletedFileIds.length : 0,
      retainedReferencedCount: Array.isArray(job.retainedReferencedFileIds)
        ? job.retainedReferencedFileIds.length
        : 0,
      pendingFileCount: Array.isArray(job.pendingFileIds)
        ? job.pendingFileIds.length
        : (job.candidateFileIds || []).length,
      status: "cleanup_pending",
      cleanupDeferred: true,
    });
  }
}

async function retryPurgeCleanup(event, actor) {
  const actorError = requireWebActor(actor);
  if (actorError) return actorError;
  const jobId = trimText(event.jobId || event.cleanupJobId);
  if (!/^purge_[a-f0-9]{40}$/.test(jobId)) {
    return fail("INVALID_PURGE_JOB_ID", "永久删除清理任务编号无效");
  }
  const job = await getDocumentOrNull(PURGE_JOB_COLLECTION, jobId);
  if (!job) return fail("PURGE_JOB_NOT_FOUND", "永久删除清理任务不存在");
  try {
    return ok(await runPurgeCleanup({ ...job, _id: jobId }));
  } catch (error) {
    if (error.code) return failFromValidation(error);
    throw error;
  }
}

function sanitizePendingPurgeJob(job, guard) {
  const cleanupJobId = trimText(job && job._id);
  const guardActive = Boolean(
    guard
    && guard.status === "active"
    && trimText(guard.activeJobId) === cleanupJobId
  );
  const storedPendingCount = Array.isArray(job && job.pendingFileIds)
    ? job.pendingFileIds.length
    : Array.isArray(job && job.candidateFileIds)
      ? job.candidateFileIds.length
      : 0;
  const releasePending = job && job.guardReleasePending === true
    || trimText(job && job.status) === "cleanup_release_pending";
  const pendingFileCount = Math.max(
    storedPendingCount,
    guardActive || releasePending ? 1 : 0
  );
  const status = releasePending
    ? "cleanup_release_pending"
    : guardActive
      ? "cleanup_in_progress"
      : trimText(job && job.status) || "cleanup_pending";
  return {
    cleanupJobId,
    clientMutationId: trimText(job && job.clientMutationId),
    deleted: Number(job && job.deletedCaseCount) || 0,
    deletedFileCount: Array.isArray(job && job.deletedFileIds)
      ? job.deletedFileIds.length
      : 0,
    retainedReferencedCount: Array.isArray(job && job.retainedReferencedFileIds)
      ? job.retainedReferencedFileIds.length
      : 0,
    pendingFileCount,
    status,
    actor: job && job.actor,
    actorDisplayName: trimText(job && job.actorDisplayName),
    caseSummaries: Array.isArray(job && job.caseSummaries)
      ? job.caseSummaries.map((item) => ({
        id: trimText(item && item.id),
        title: trimText(item && item.title).slice(0, 120),
        caseId: trimText(item && item.caseId).slice(0, 80),
      }))
      : [],
    createdAt: job && job.createdAt,
    updatedAt: job && (job.cleanupUpdatedAt || job.updatedAt),
  };
}

function isRecoverablePurgeJob(job, guard) {
  if (!job || trimText(job._id) === PURGE_GUARD_DOCUMENT_ID) return false;
  const status = trimText(job.status);
  const guardActive = guard
    && guard.status === "active"
    && trimText(guard.activeJobId) === trimText(job._id);
  return Boolean(
    guardActive
    || job.guardReleasePending === true
    || status === "cleanup_pending"
    || status === "cleanup_release_pending"
    || (Array.isArray(job.pendingFileIds) && job.pendingFileIds.length)
  );
}

async function listPendingPurgeJobs(event, actor) {
  const actorError = requireWebActor(actor);
  if (actorError) return actorError;
  const rawMutationId = trimText(event.clientMutationId);
  let jobs = [];
  if (rawMutationId) {
    const mutation = normalizeClientMutationId(rawMutationId);
    if (!mutation.valid || !mutation.value) return failFromValidation(mutation);
    const jobId = getPurgeJobDocumentId(actor, mutation.value);
    const job = await getDocumentOrNull(PURGE_JOB_COLLECTION, jobId);
    if (job) jobs = [{ ...job, _id: jobId }];
  } else {
    jobs = await scanCollectionByStableId(PURGE_JOB_COLLECTION);
  }
  const guard = await getPurgeGuard();
  const items = jobs
    .filter((job) => isRecoverablePurgeJob(job, guard))
    .map((job) => sanitizePendingPurgeJob(job, guard))
    .sort((left, right) => (
      getDateTimestamp(right.updatedAt || right.createdAt)
      - getDateTimestamp(left.updatedAt || left.createdAt)
    ))
    .slice(0, ADMIN_RECORD_RETENTION_LIMIT);
  return ok({ items });
}

async function validatePinnedCapacity(isPinned, excludedId = "") {
  if (!isPinned) return null;
  const cases = await fetchAllCases();
  const count = cases.filter(
    (item) => item.isPinned === true && !item.deletedAt && item._id !== excludedId
  ).length;
  return count >= PINNED_CASE_LIMIT
    ? fail("PINNED_LIMIT_REACHED", `置顶案例最多 ${PINNED_CASE_LIMIT} 个，请先取消其他案例的置顶`)
    : null;
}

async function applyCaseUpdatePlans(plans, actor, expectedVersions = {}, options = {}) {
  const versions = {};
  try {
    const chunkSize = Math.max(1, Math.min(
      Number(options.chunkSize) || CASE_BATCH_MAX,
      CASE_BATCH_MAX
    ));
    for (let offset = 0; offset < plans.length; offset += chunkSize) {
      const chunk = plans.slice(offset, offset + chunkSize);
      const chunkVersions = {};
      await withTransaction(async (transaction) => {
        const currentRows = [];
        for (const plan of chunk) {
          const ref = transaction.collection(CASE_COLLECTION).doc(plan.id);
          const response = await ref.get();
          const current = response.data;
          const validation = validateExpectedVersion(
            current,
            expectedVersions && expectedVersions[plan.id],
            { required: options.requireVersions === true }
          );
          if (!validation.valid) {
            const error = new Error(validation.message);
            Object.assign(error, validation, { id: plan.id });
            throw error;
          }
          const version = getRecordVersion(current) + 1;
          chunkVersions[plan.id] = version;
          currentRows.push({ plan, ref, version });
        }
        // CloudBase transactions require reads to finish before writes begin.
        for (const { plan, ref, version } of currentRows) {
          await ref.update({
            data: {
              ...plan.data,
              version,
              updatedAt: db.serverDate(),
              ...actorAuditFields(actor, "updated"),
            },
          });
        }
      }, { required: true });
      // A transaction callback may be retried or may fail after validating
      // some records. Only expose versions after the whole chunk commits.
      Object.assign(versions, chunkVersions);
    }
  } catch (error) {
    const normalizedError =
      error && typeof error === "object"
        ? error
        : new Error("数据库事务写入失败");
    normalizedError.code = trimText(
      normalizedError.code || normalizedError.errCode
    ) || "TRANSACTION_FAILED";
    normalizedError.message = trimText(normalizedError.message)
      || "数据库事务写入失败，请稍后重试";
    return {
      ok: false,
      error: normalizedError,
      appliedIds: Object.keys(versions),
      versions,
    };
  }
  return { ok: true, versions };
}

async function getVisibleBanners() {
  const response = await db
    .collection(BANNER_COLLECTION)
    .where({ isVisible: true })
    .orderBy("sortOrder", "asc")
    .limit(SEARCH_FETCH_LIMIT)
    .get();
  return response.data || [];
}

async function batchPatchCases(event, actor) {
  const idsResult = normalizeCaseIds(event.ids);
  if (!idsResult.valid) return failFromValidation(idsResult);
  const items = await fetchCasesByIds(idsResult.ids);
  const foundValidation = ensureAllCasesFound(idsResult.ids, items);
  if (!foundValidation.valid) return failFromValidation(foundValidation);
  if (items.some((item) => item.deletedAt)) {
    return fail("CASE_IN_TRASH", "回收站中的案例不能批量修改");
  }

  const plans = [];
  const nextById = new Map();
  for (const item of items) {
    const versionValidation = validateExpectedVersion(
      item,
      getExpectedVersion(event, item._id),
      { required: actor.type === "cloudbase_uid" }
    );
    if (!versionValidation.valid) return failFromValidation(versionValidation);
    const patchResult = buildBatchCasePatch(item, event);
    if (!patchResult.valid) return failFromValidation(patchResult);
    const next = { ...item, ...patchResult.data };
    const readyValidation = validateCaseReadyForVisibility(next);
    if (!readyValidation.valid) return failFromValidation(readyValidation);
    nextById.set(item._id, next);
    plans.push({ id: item._id, data: patchResult.data });
  }

  const allCases = await fetchAllCases();
  const nextCases = allCases.map((item) => nextById.get(item._id) || item);
  const pinnedCount = nextCases.filter((item) => item.isPinned === true && !item.deletedAt).length;
  if (pinnedCount > PINNED_CASE_LIMIT) {
    return fail("PINNED_LIMIT_REACHED", `置顶案例最多 ${PINNED_CASE_LIMIT} 个`);
  }
  const homepageValidation = validateAllHomepageCapacity(nextCases, await getVisibleBanners());
  if (!homepageValidation.valid) return failFromValidation(homepageValidation);

  const applied = await applyCaseUpdatePlans(
    plans,
    actor,
    event.expectedVersions,
    { requireVersions: actor.type === "cloudbase_uid" }
  );
  if (!applied.ok) return failFromValidation(applied.error);
  await bumpCatalogRevision();
  return ok({ updated: plans.length, versions: applied.versions });
}

async function moveCasesToTrash(event, actor) {
  const idsResult = normalizeCaseIds(event.ids || [event.id]);
  if (!idsResult.valid) return failFromValidation(idsResult);
  const items = await fetchCasesByIds(idsResult.ids);
  const foundValidation = ensureAllCasesFound(idsResult.ids, items);
  if (!foundValidation.valid) return failFromValidation(foundValidation);
  if (items.some((item) => item.deletedAt)) {
    return fail("CASE_ALREADY_TRASHED", "所选案例已在回收站中");
  }
  for (const item of items) {
    const validation = validateExpectedVersion(item, getExpectedVersion(event, item._id), {
      required: actor.type === "cloudbase_uid",
    });
    if (!validation.valid) return failFromValidation(validation);
  }

  const deletedAt = db.serverDate();
  const plans = items.map((item) => ({
    id: item._id,
    data: {
      deletedAt,
      deletedBy: actor,
      isVisible: false,
      isPinned: false,
      homeSections: { values: [] },
      homeSectionOrder: {},
    },
  }));
  const applied = await applyCaseUpdatePlans(
    plans,
    actor,
    event.expectedVersions || (
      event.expectedVersion !== undefined ? { [idsResult.ids[0]]: event.expectedVersion } : {}
    ),
    { requireVersions: actor.type === "cloudbase_uid" }
  );
  if (!applied.ok) return failFromValidation(applied.error);
  await bumpCatalogRevision();
  await Promise.all(items.map((item) => writeAdminActivitySafe({
    action: "case_moved_to_trash",
    targetType: "case",
    targetId: item._id,
    title: item.title,
    caseId: item.caseId,
  }, actor, `case-trash:${item._id}:${applied.versions[item._id]}`)));
  return ok({
    moved: plans.length,
    ids: idsResult.ids,
    id: idsResult.ids.length === 1 ? idsResult.ids[0] : undefined,
    versions: applied.versions,
  });
}

async function restoreCases(event, actor) {
  const idsResult = normalizeCaseIds(event.ids || [event.id]);
  if (!idsResult.valid) return failFromValidation(idsResult);
  const items = await fetchCasesByIds(idsResult.ids);
  const foundValidation = ensureAllCasesFound(idsResult.ids, items);
  if (!foundValidation.valid) return failFromValidation(foundValidation);
  if (items.some((item) => !item.deletedAt)) {
    return fail("CASE_NOT_IN_TRASH", "所选案例不在回收站中");
  }
  for (const item of items) {
    const validation = validateExpectedVersion(item, getExpectedVersion(event, item._id), {
      required: actor.type === "cloudbase_uid",
    });
    if (!validation.valid) return failFromValidation(validation);
  }
  const plans = items.map((item) => ({
    id: item._id,
    data: {
      deletedAt: null,
      deletedBy: null,
      isVisible: false,
    },
  }));
  const applied = await applyCaseUpdatePlans(
    plans,
    actor,
    event.expectedVersions || (
      event.expectedVersion !== undefined ? { [idsResult.ids[0]]: event.expectedVersion } : {}
    ),
    { requireVersions: actor.type === "cloudbase_uid" }
  );
  if (!applied.ok) return failFromValidation(applied.error);
  await bumpCatalogRevision();
  await Promise.all(items.map((item) => writeAdminActivitySafe({
    action: "case_restored",
    targetType: "case",
    targetId: item._id,
    title: item.title,
    caseId: item.caseId,
  }, actor, `case-restore:${item._id}:${applied.versions[item._id]}`)));
  return ok({ restored: plans.length, ids: idsResult.ids, versions: applied.versions });
}

async function reorderCases(event, actor) {
  const idsResult = normalizeCaseIds(event.orderedIds || event.ids, 10000);
  if (!idsResult.valid) return failFromValidation(idsResult);
  const items = await fetchCasesByIds(idsResult.ids);
  const foundValidation = ensureAllCasesFound(idsResult.ids, items);
  if (!foundValidation.valid) return failFromValidation(foundValidation);
  if (items.some((item) => item.deletedAt)) {
    return fail("CASE_IN_TRASH", "回收站中的案例不能参与排序");
  }
  const allActiveCases = (await fetchAllCases()).filter((item) => !item.deletedAt);
  const requestedSet = new Set(idsResult.ids);
  if (
    allActiveCases.length !== idsResult.ids.length ||
    allActiveCases.some((item) => !requestedSet.has(item._id))
  ) {
    return fail(
      "REORDER_REQUIRES_ALL_CASES",
      "全局排序必须包含全部非回收站案例，请刷新完整列表后重试"
    );
  }
  for (const item of items) {
    const validation = validateExpectedVersion(item, getExpectedVersion(event, item._id), {
      required: actor.type === "cloudbase_uid",
    });
    if (!validation.valid) return failFromValidation(validation);
  }
  const plans = idsResult.ids.map((id, index) => ({
    id,
    data: { sortOrder: index + 1 },
  }));
  const applied = await applyCaseUpdatePlans(
    plans,
    actor,
    event.expectedVersions,
    { requireVersions: actor.type === "cloudbase_uid" }
  );
  if (!applied.ok) {
    const originalById = new Map(items.map((item) => [item._id, item.sortOrder]));
    const rollbackPlans = applied.appliedIds.map((id) => ({
      id,
      data: {
        sortOrder: Number.isFinite(Number(originalById.get(id)))
          ? Number(originalById.get(id))
          : 9999,
      },
    }));
    try {
      const rollback = await applyCaseUpdatePlans(
        rollbackPlans,
        actor,
        applied.versions,
        { requireVersions: true }
      );
      if (!rollback.ok) {
        return fail(
          "REORDER_PARTIAL_FAILURE",
          "排序写入和自动回滚均未完整完成，请暂停写入并检查目录"
        );
      }
    } catch (rollbackError) {
      console.error("reorder rollback error", rollbackError);
      return fail(
        "REORDER_PARTIAL_FAILURE",
        "排序写入和自动回滚均未完整完成，请暂停写入并检查目录"
      );
    }
    return failFromValidation(applied.error);
  }
  await bumpCatalogRevision();
  return ok({ updated: plans.length, versions: applied.versions });
}

async function setHomeSectionOrder(event, actor) {
  let rawOrders = event.orders;
  if (!rawOrders && normalizeHomepageDisplaySlot(event.slot)) {
    const allCases = await fetchAllCases();
    rawOrders = Object.keys(HOME_DISPLAY_LIMITS).reduce((orders, slot) => {
      orders[slot] = buildHomepageDisplayItems(allCases, [], {
        slot,
        applyLimit: false,
      }).map((item) => item.id);
      return orders;
    }, {});
    rawOrders[event.slot] = event.orderedIds || event.ids || [];
  }
  const ordersResult = validateHomepageOrders(rawOrders);
  if (!ordersResult.valid) return failFromValidation(ordersResult);

  const allCases = await fetchAllCases();
  const allIds = Object.values(ordersResult.orders).flat();
  const byId = new Map(allCases.map((item) => [item._id, item]));
  const missingIds = allIds.filter((id) => !byId.has(id));
  if (missingIds.length) {
    return fail("CASE_NOT_FOUND", `以下首页案例不存在：${missingIds.join("、")}`);
  }
  if (allIds.some((id) => {
    const item = byId.get(id);
    return item.deletedAt || item.isVisible !== true;
  })) {
    return fail("INVALID_HOME_CASE", "首页只能编排存在且已上架的案例");
  }

  const selectedSlotsById = new Map();
  for (const [slot, ids] of Object.entries(ordersResult.orders)) {
    ids.forEach((id, index) => {
      const selection = selectedSlotsById.get(id) || { slots: [], order: {} };
      selection.slots.push(slot);
      selection.order[slot] = index + 1;
      selectedSlotsById.set(id, selection);
    });
  }
  const plans = [];
  const nextCases = allCases.map((item) => {
    if (item.deletedAt) return item;
    const selection = selectedSlotsById.get(item._id);
    const currentlyConfigured =
      (item.homeSections && Array.isArray(item.homeSections.values) && item.homeSections.values.length) ||
      (item.homeSectionOrder && Object.keys(item.homeSectionOrder).length);
    if (!selection && !currentlyConfigured) return item;
    const data = {
      homeSections: { values: selection ? selection.slots : [] },
      homeSectionOrder: selection ? selection.order : {},
    };
    plans.push({ id: item._id, data });
    return { ...item, ...data };
  });
  const homepageValidation = validateAllHomepageCapacity(nextCases, await getVisibleBanners());
  if (!homepageValidation.valid) return failFromValidation(homepageValidation);

  if (actor.type === "cloudbase_uid") {
    for (const plan of plans) {
      const item = byId.get(plan.id);
      const validation = validateExpectedVersion(
        item,
        event.expectedVersions && event.expectedVersions[plan.id],
        { required: true }
      );
      if (!validation.valid) return failFromValidation(validation);
    }
  }
  const applied = await applyCaseUpdatePlans(
    plans,
    actor,
    event.expectedVersions,
    { requireVersions: actor.type === "cloudbase_uid" }
  );
  if (!applied.ok) {
    const rollbackPlans = applied.appliedIds.map((id) => {
      const original = byId.get(id) || {};
      return {
        id,
        data: {
          homeSections: original.homeSections || { values: [] },
          homeSectionOrder: original.homeSectionOrder || {},
        },
      };
    });
    const rollback = await applyCaseUpdatePlans(
      rollbackPlans,
      actor,
      applied.versions,
      { requireVersions: true }
    );
    if (!rollback.ok) {
      return fail(
        "HOME_SECTION_PARTIAL_FAILURE",
        "首页编排写入和自动回滚均未完整完成，请暂停写入并检查首页配置"
      );
    }
    return failFromValidation(applied.error);
  }
  await bumpCatalogRevision();
  return ok({
    updated: plans.length,
    orders: ordersResult.orders,
    versions: applied.versions,
  });
}

async function deleteCase(event, actor) {
  const id = trimText(event.id);
  if (!id) return fail("INVALID_ID", "缺少案例 ID");
  return moveCasesToTrash({
    ...event,
    ids: [id],
  }, actor);
}

exports.main = async (event = {}) => {
  const action = trimText(event.action);

  if (action === "getVisibleImageUrls") {
    try {
      return await getVisibleImageUrls(event);
    } catch (error) {
      console.error("caseAdmin public image url error", error);
      return fail("SERVER_ERROR", error.message || "案例图片服务异常");
    }
  }

  const resolved = await resolveRequestIdentity();
  if (resolved.error) {
    console.error("caseAdmin identity error", resolved.error);
    return fail("SERVER_ERROR", "管理员身份服务异常，请稍后重试");
  }
  const identity = resolved.identity || { authenticated: false, actor: null };
  const admin = identity.authenticated && isAdminActor(identity.actor, process.env);

  if (action === "checkAccess") {
    if (!identity.authenticated) {
      return fail("UNAUTHENTICATED", "登录已过期，请重新登录");
    }
    if (!admin) {
      return fail("FORBIDDEN", "无权限管理案例");
    }
    return ok({
      isAdmin: true,
      authenticated: true,
      actor: identity.actor,
    });
  }

  if (!identity.authenticated) {
    return fail("UNAUTHENTICATED", "登录已过期，请重新登录");
  }
  if (!admin) {
    return fail("FORBIDDEN", "无权限管理案例");
  }
  const actor = identity.actor;
  if (
    actor.type === "cloudbase_uid" &&
    WEB_WRITE_ACTIONS.has(action) &&
    !isWebWriteEnabled(process.env.ADMIN_WEB_WRITE_ENABLED)
  ) {
    return fail("WEB_WRITE_DISABLED", "电脑后台当前为只读模式");
  }
  if (ACTIVITY_SYNC_ACTIONS.has(action) && !isActivitySyncEnabled()) {
    return fail("ACTIVITY_SYNC_DISABLED", "管理员实时同步功能尚未开启");
  }
  if (PERMANENT_DELETE_ACTIONS.has(action) && !isPermanentDeleteEnabled()) {
    return fail("PERMANENT_DELETE_DISABLED", "回收站永久删除功能尚未开启");
  }

  try {
    if (action === "getAdminConfig") return await getAdminConfig(actor);
    if (action === "listCases") return await listCases(event);
    if (action === "listCasesV2") return await listCasesV2(event);
    if (action === "listRecentCases") return await listRecentCases(event);
    if (action === "listHomepageDisplay") return await listHomepageDisplay(event);
    if (action === "getCase") return await getCase(event);
    if (action === "getCaseImageUrls") return await getCaseImageUrls(event);
    if (action === "prepareVideoUpload") return await prepareVideoUpload(event, actor);
    if (action === "createCase") return await createCase(event, actor);
    if (action === "updateCase") return await updateCase(event, actor);
    if (action === "batchPatchCases") return await batchPatchCases(event, actor);
    if (action === "moveCasesToTrash") return await moveCasesToTrash(event, actor);
    if (action === "restoreCases") return await restoreCases(event, actor);
    if (action === "reorderCases") return await reorderCases(event, actor);
    if (action === "setHomeSectionOrder") return await setHomeSectionOrder(event, actor);
    if (action === "setCaseVisibility") return await setCaseVisibility(event, actor);
    if (action === "deleteCase") return await deleteCase(event, actor);
    if (action === "permanentlyDeleteCases") {
      return await permanentlyDeleteCases(event, actor);
    }
    if (action === "retryPurgeCleanup") return await retryPurgeCleanup(event, actor);
    if (action === "listPendingPurgeJobs") {
      return await listPendingPurgeJobs(event, actor);
    }
    if (action === "registerUploadItems") return await registerUploadItems(event, actor);
    if (action === "updateUploadItemStatus") {
      return await updateUploadItemStatus(event, actor);
    }
    if (action === "removeUploadItem") return await removeUploadItem(event, actor);
    if (action === "listSharedUploadItems") {
      return await listSharedUploadItems(event, actor);
    }
    if (action === "listAdminActivity") return await listAdminActivity(event, actor);
    if (action === "cleanupUnreferencedFiles") {
      return await cleanupUnreferencedFiles(event, actor);
    }
    return fail("UNKNOWN_ACTION", "未知案例管理操作");
  } catch (error) {
    console.error("caseAdmin error", error);
    return fail("SERVER_ERROR", error.message || "案例管理服务异常");
  }
};
