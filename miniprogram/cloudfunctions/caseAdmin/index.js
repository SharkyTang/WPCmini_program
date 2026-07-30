const crypto = require("node:crypto");
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
  buildBatchCasePatch,
  buildCaseKeywords,
  buildHomepageDisplayItems,
  filterCaseItems,
  filterCaseItemsV2,
  generateSequentialCaseId,
  getCloudFilePath,
  getActivatedHomepageSlots,
  getCaseIdNumber,
  getRecordVersion,
  hasCaseImageChanges,
  isAdminActor,
  isWebAdminUploadFile,
  isWebWriteEnabled,
  normalizeCaseIds,
  normalizeClientMutationId,
  normalizeCloudFileIds,
  normalizeHomepageDisplaySlot,
  normalizePage,
  normalizePageSize,
  normalizeVisibilityFilter,
  paginateCaseItems,
  resolveAdminActor,
  sanitizeCasePayload,
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

async function loadOfficialCloudbaseUserInfo() {
  let sdk;
  try {
    // Kept lazy so the legacy WeChat runtime can still start during a staged
    // dependency rollout. Production deployments include this dependency.
    sdk = require("@cloudbase/node-sdk");
  } catch (error) {
    return { available: false, userInfo: null, error: null };
  }
  try {
    const app = sdk.init({
      env: sdk.SYMBOL_CURRENT_ENV || process.env.TCB_ENV || process.env.SCF_NAMESPACE,
    });
    return {
      available: true,
      userInfo: app.auth().getUserInfo(),
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
        homepage: HOME_DISPLAY_LIMITS,
      },
      writeEnabled,
      homeSectionOrders,
      upload: {
        acceptedExtensions: [".jpg", ".jpeg", ".png", ".webp"],
        pathPrefix: actor && actor.type === "cloudbase_uid"
          ? `wine-packaging/admin-web/${encodeURIComponent(actor.id)}/`
          : "wine-packaging/",
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
  return ok({ item: response.data || null });
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
      return ok(atomicResult);
    } catch (error) {
      console.error("atomic web case create error", error);
      return fail(
        error.code || "CASE_NUMBER_RESERVATION_FAILED",
        "案例创建事务失败，请稍后重试"
      );
    }
  }

  const response = await db.collection(CASE_COLLECTION).add({
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
  await bumpCatalogRevision();

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
  const versionValidation = validateExpectedVersion(existing, event.expectedVersion, {
    required: actor && actor.type === "cloudbase_uid",
  });
  if (!versionValidation.valid) return failFromValidation(versionValidation);
  const input = event.case || event.data || {};
  const result = sanitizeCasePayload(input, {
    isCreate: false,
    allowIncompleteHidden: actor && actor.type === "cloudbase_uid",
  });
  if (!result.valid) return fail(result.code, result.message);
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
  if (hasCaseImageChanges(existing, result.data)) {
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
  try {
    await withTransaction(async (transaction) => {
      const ref = transaction.collection(CASE_COLLECTION).doc(id);
      const currentResponse = await ref.get();
      const current = currentResponse.data;
      const currentValidation = validateExpectedVersion(current, event.expectedVersion, {
        required: actor && actor.type === "cloudbase_uid",
      });
      if (!currentValidation.valid) {
        const error = new Error(currentValidation.message);
        Object.assign(error, currentValidation);
        throw error;
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
    }, { required: actor && actor.type === "cloudbase_uid" });
  } catch (error) {
    if (error.code) return failFromValidation(error);
    throw error;
  }
  const nextFileIds = new Set(getCaseImageFileIds({ ...existing, ...result.data }));
  const sourceFileIds = new Set(getCaseSourceFileIds(existing));
  const removedFileIds = getCaseImageFileIds(existing).filter(
    (fileID) => !nextFileIds.has(fileID) && !sourceFileIds.has(fileID)
  );
  await deleteUnreferencedCaseFiles(removedFileIds);
  await bumpCatalogRevision();

  return ok({ id, version: nextVersion });
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
      (bannerResponse.data || []).length ||
      (optimizedBannerResponse.data || []).length
  );
}

async function deleteUnreferencedCaseFiles(fileIDs = []) {
  const deletedFileIds = [];
  for (const fileID of Array.from(new Set(fileIDs.filter((value) => value.indexOf("cloud://") === 0)))) {
    if (await isCaseImageReferenced(fileID)) continue;
    try {
      await cloud.deleteFile({ fileList: [fileID] });
      deletedFileIds.push(fileID);
    } catch (error) {
      console.warn("case image file delete failed", error);
    }
  }
  return deletedFileIds;
}

function isAllowedCleanupFile(fileID, actor) {
  const path = getCloudFilePath(fileID);
  const isVariant = /^wine-packaging\/variants\/v2\/[a-f0-9]{32}\/(?:display|thumbnail|banner)\.jpg$/i.test(path);
  if (actor && actor.type === "cloudbase_uid") {
    return isVariant || isWebAdminUploadFile(fileID, actor.id);
  }
  return isVariant || /^wine-packaging\/admin\/[^/]+\.(?:jpe?g|png|webp)$/i.test(path);
}

async function cleanupUnreferencedFiles(event, actor) {
  const fileIDs = normalizeCloudFileIds(event.fileIDs || event.fileIds);
  if (!fileIDs.length) return ok({ deletedFileIds: [] });
  if (fileIDs.some((fileID) => !isAllowedCleanupFile(fileID, actor))) {
    return fail(
      "INVALID_CLEANUP_PATH",
      "只能清理案例上传目录中的临时图片"
    );
  }
  const deletedFileIds = await deleteUnreferencedCaseFiles(fileIDs);
  return ok({ deletedFileIds });
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

  try {
    if (action === "getAdminConfig") return await getAdminConfig(actor);
    if (action === "listCases") return await listCases(event);
    if (action === "listCasesV2") return await listCasesV2(event);
    if (action === "listRecentCases") return await listRecentCases(event);
    if (action === "listHomepageDisplay") return await listHomepageDisplay(event);
    if (action === "getCase") return await getCase(event);
    if (action === "getCaseImageUrls") return await getCaseImageUrls(event);
    if (action === "createCase") return await createCase(event, actor);
    if (action === "updateCase") return await updateCase(event, actor);
    if (action === "batchPatchCases") return await batchPatchCases(event, actor);
    if (action === "moveCasesToTrash") return await moveCasesToTrash(event, actor);
    if (action === "restoreCases") return await restoreCases(event, actor);
    if (action === "reorderCases") return await reorderCases(event, actor);
    if (action === "setHomeSectionOrder") return await setHomeSectionOrder(event, actor);
    if (action === "setCaseVisibility") return await setCaseVisibility(event, actor);
    if (action === "deleteCase") return await deleteCase(event, actor);
    if (action === "cleanupUnreferencedFiles") {
      return await cleanupUnreferencedFiles(event, actor);
    }
    return fail("UNKNOWN_ACTION", "未知案例管理操作");
  } catch (error) {
    console.error("caseAdmin error", error);
    return fail("SERVER_ERROR", error.message || "案例管理服务异常");
  }
};
