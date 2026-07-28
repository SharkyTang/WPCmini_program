const cloud = require("wx-server-sdk");
const {
  BANNER_COLLECTION,
  CASE_GALLERY_MAX,
  CASE_COLLECTION,
  IMAGE_URL_BATCH_SIZE,
  SEARCH_FETCH_LIMIT,
  PINNED_CASE_LIMIT,
  buildHomepageDisplayItems,
  filterCaseItems,
  generateSequentialCaseId,
  getActivatedHomepageSlots,
  getCaseIdNumber,
  isAdminOpenid,
  normalizeCloudFileIds,
  normalizeHomepageDisplaySlot,
  normalizePage,
  normalizePageSize,
  normalizeVisibilityFilter,
  sanitizeCasePayload,
  trimText,
  validateHomepageDisplayCapacity,
} = require("./caseAdminLogic");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();
const _ = db.command;
const RECENT_CASE_WINDOW_MS = 24 * 60 * 60 * 1000;

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

async function listCases(event) {
  const page = normalizePage(event.page);
  const pageSize = normalizePageSize(event.pageSize);
  const visibility = normalizeVisibilityFilter(event.visibility);
  const keyword = trimText(event.keyword);
  const query = db.collection(CASE_COLLECTION);

  if (keyword || visibility !== "all") {
    const response = await query
      .orderBy("sortOrder", "asc")
      .limit(SEARCH_FETCH_LIMIT)
      .get();
    const filteredItems = filterCaseItems(response.data || [], {
      keyword,
      visibility,
    });
    const start = (page - 1) * pageSize;
    return ok({
      items: filteredItems.slice(start, start + pageSize),
      page,
      pageSize,
      hasMore: start + pageSize < filteredItems.length,
    });
  }

  const response = await query
    .orderBy("sortOrder", "asc")
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

  const casesRequest = db
    .collection(CASE_COLLECTION)
    .where({ isVisible: true })
    .orderBy("sortOrder", "asc")
    .limit(SEARCH_FETCH_LIMIT)
    .get();
  const bannersRequest = slot === "banner"
    ? db
      .collection(BANNER_COLLECTION)
      .where({ isVisible: true })
      .orderBy("sortOrder", "asc")
      .limit(SEARCH_FETCH_LIMIT)
      .get()
    : Promise.resolve({ data: [] });
  const [caseResponse, bannerResponse] = await Promise.all([casesRequest, bannersRequest]);
  const items = buildHomepageDisplayItems(caseResponse.data || [], bannerResponse.data || [], {
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
    return null;
  }
}

async function getCreateCaseDefaults() {
  const response = await db
    .collection(CASE_COLLECTION)
    .field({ caseId: true })
    .limit(SEARCH_FETCH_LIMIT)
    .get();
  const defaultCaseId = generateSequentialCaseId(response.data || []);
  return {
    defaultCaseId,
    defaultSortOrder: getCaseIdNumber(defaultCaseId),
  };
}

async function validateHomepageCapacity(nextCase, slots, excludedId = "") {
  if (!slots.length) return null;
  const [caseResponse, bannerResponse] = await Promise.all([
    db
      .collection(CASE_COLLECTION)
      .where({ isVisible: true })
      .field({ _id: true, caseId: true, homeSections: true, sortOrder: true, isVisible: true })
      .limit(SEARCH_FETCH_LIMIT)
      .get(),
    db
      .collection(BANNER_COLLECTION)
      .where({ isVisible: true })
      .field({ _id: true, caseId: true, image: true, sortOrder: true, isVisible: true })
      .limit(SEARCH_FETCH_LIMIT)
      .get(),
  ]);
  const validation = validateHomepageDisplayCapacity(
    caseResponse.data || [],
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

async function fetchCaseImageFileIdSet(fileIDs = [], where = {}) {
  const normalizedFileIDs = normalizeCloudFileIds(fileIDs);
  if (!normalizedFileIDs.length) return new Set();
  const [coverResponse, thumbnailResponse, galleryResponse] = await Promise.all([
    db.collection(CASE_COLLECTION).where({ ...where, coverImage: _.in(normalizedFileIDs) })
      .field({ coverImage: true }).limit(IMAGE_URL_BATCH_SIZE).get(),
    db.collection(CASE_COLLECTION).where({ ...where, coverThumbnail: _.in(normalizedFileIDs) })
      .field({ coverThumbnail: true }).limit(IMAGE_URL_BATCH_SIZE).get(),
    db.collection(CASE_COLLECTION).where({ ...where, galleryImages: _.in(normalizedFileIDs) })
      .field({ galleryImages: true }).limit(IMAGE_URL_BATCH_SIZE).get(),
  ]);
  return new Set([
    ...buildFileIdSet(coverResponse.data || [], "coverImage"),
    ...buildFileIdSet(thumbnailResponse.data || [], "coverThumbnail"),
    ...buildFileIdSet(galleryResponse.data || [], "galleryImages"),
  ]);
}

async function fetchVisibleBannerFileIdSet(fileIDs = []) {
  const normalizedFileIDs = normalizeCloudFileIds(fileIDs);
  if (!normalizedFileIDs.length) return new Set();
  const response = await db
    .collection(BANNER_COLLECTION)
    .where({
      isVisible: true,
      image: _.in(normalizedFileIDs),
    })
    .field({ image: true })
    .limit(IMAGE_URL_BATCH_SIZE)
    .get();
  return buildFileIdSet(response.data || [], "image");
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
    fetchCaseImageFileIdSet(fileIDs, { isVisible: true }),
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

async function createCase(event, openid) {
  const input = event.case || event.data || {};
  const defaults = await getCreateCaseDefaults();
  const result = sanitizeCasePayload(input, {
    isCreate: true,
    now: Date.now(),
    ...defaults,
  });
  if (!result.valid) return fail(result.code, result.message);
  const pinnedError = await validatePinnedCapacity(result.data.isPinned);
  if (pinnedError) return pinnedError;
  const homepageError = await validateHomepageCapacity(
    result.data,
    getActivatedHomepageSlots(null, result.data)
  );
  if (homepageError) return homepageError;

  const response = await db.collection(CASE_COLLECTION).add({
    data: {
      ...result.data,
      createdAt: db.serverDate(),
      updatedAt: db.serverDate(),
      createdByOpenid: openid,
      updatedByOpenid: openid,
    },
  });

  return ok({
    id: response._id,
    caseId: result.data.caseId,
  });
}

async function updateCase(event, openid) {
  const id = trimText(event.id);
  if (!id) return fail("INVALID_ID", "缺少案例 ID");

  const existing = await getCaseById(id);
  if (!existing) return fail("CASE_NOT_FOUND", "案例不存在或已删除");
  const input = event.case || event.data || {};
  const result = sanitizeCasePayload(input, { isCreate: false });
  if (!result.valid) return fail(result.code, result.message);
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
  const homepageError = await validateHomepageCapacity(
    nextCase,
    getActivatedHomepageSlots(existing, nextCase),
    id
  );
  if (homepageError) return homepageError;

  await db.collection(CASE_COLLECTION).doc(id).update({
    data: {
      ...result.data,
      updatedAt: db.serverDate(),
      updatedByOpenid: openid,
    },
  });
  const nextFileIds = new Set(getCaseImageFileIds({ ...existing, ...result.data }));
  const removedFileIds = getCaseImageFileIds(existing).filter((fileID) => !nextFileIds.has(fileID));
  await deleteUnreferencedCaseFiles(removedFileIds);

  return ok({ id });
}

async function setCaseVisibility(event, openid) {
  const id = trimText(event.id);
  if (!id) return fail("INVALID_ID", "缺少案例 ID");
  const existing = await getCaseById(id);
  if (!existing) return fail("CASE_NOT_FOUND", "案例不存在或已删除");
  const nextCase = {
    ...existing,
    _id: id,
    isVisible: event.isVisible === true,
  };
  const homepageError = await validateHomepageCapacity(
    nextCase,
    getActivatedHomepageSlots(existing, nextCase),
    id
  );
  if (homepageError) return homepageError;

  await db.collection(CASE_COLLECTION).doc(id).update({
    data: {
      isVisible: event.isVisible === true,
      updatedAt: db.serverDate(),
      updatedByOpenid: openid,
    },
  });

  return ok({
    id,
    isVisible: event.isVisible === true,
  });
}

function getCaseImageFileIds(item = {}) {
  return Array.from(new Set([
    trimText(item.coverImage),
    trimText(item.coverThumbnail),
    ...normalizeCloudFileIds(item.galleryImages || [], CASE_GALLERY_MAX),
  ].filter((fileID) => fileID.indexOf("cloud://") === 0)));
}

async function isCaseImageReferenced(fileID) {
  if (!fileID || fileID.indexOf("cloud://") !== 0) return false;

  const [coverResponse, thumbnailResponse, galleryResponse, bannerResponse] = await Promise.all([
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
      .collection(BANNER_COLLECTION)
      .where({ image: fileID })
      .field({ _id: true })
      .limit(1)
      .get(),
  ]);

  return Boolean(
      (coverResponse.data || []).length ||
      (thumbnailResponse.data || []).length ||
      (galleryResponse.data || []).length ||
      (bannerResponse.data || []).length
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

async function validatePinnedCapacity(isPinned, excludedId = "") {
  if (!isPinned) return null;
  const response = await db.collection(CASE_COLLECTION)
    .where({ isPinned: true })
    .field({ _id: true })
    .limit(PINNED_CASE_LIMIT + 1)
    .get();
  const count = (response.data || []).filter((item) => item._id !== excludedId).length;
  return count >= PINNED_CASE_LIMIT
    ? fail("PINNED_LIMIT_REACHED", `置顶案例最多 ${PINNED_CASE_LIMIT} 个，请先取消其他案例的置顶`)
    : null;
}

async function deleteCase(event) {
  const id = trimText(event.id);
  if (!id) return fail("INVALID_ID", "缺少案例 ID");

  const item = await getCaseById(id);
  if (!item) return fail("CASE_NOT_FOUND", "案例不存在或已删除");

  const imageFileIds = getCaseImageFileIds(item);
  await db.collection(CASE_COLLECTION).doc(id).remove();
  const deletedFileIds = await deleteUnreferencedCaseFiles(imageFileIds);

  return ok({
    id,
    deletedFileIds,
  });
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const action = trimText(event.action);
  const admin = isAdminOpenid(OPENID, process.env.ADMIN_OPENIDS);

  if (action === "checkAccess") {
    return ok({ isAdmin: admin });
  }

  if (action === "getVisibleImageUrls") {
    return getVisibleImageUrls(event);
  }

  if (!admin) {
    return fail("FORBIDDEN", "无权限管理案例");
  }

  try {
    if (action === "listCases") return listCases(event);
    if (action === "listRecentCases") return listRecentCases(event);
    if (action === "listHomepageDisplay") return listHomepageDisplay(event);
    if (action === "getCase") return getCase(event);
    if (action === "getCaseImageUrls") return getCaseImageUrls(event);
    if (action === "createCase") return createCase(event, OPENID);
    if (action === "updateCase") return updateCase(event, OPENID);
    if (action === "setCaseVisibility") return setCaseVisibility(event, OPENID);
    if (action === "deleteCase") return deleteCase(event);
    return fail("UNKNOWN_ACTION", "未知案例管理操作");
  } catch (error) {
    console.error("caseAdmin error", error);
    return fail("SERVER_ERROR", error.message || "案例管理服务异常");
  }
};
