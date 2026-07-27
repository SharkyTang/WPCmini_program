const cloud = require("wx-server-sdk");
const {
  BANNER_COLLECTION,
  CASE_COLLECTION,
  IMAGE_URL_BATCH_SIZE,
  SEARCH_FETCH_LIMIT,
  filterCaseItems,
  generateSequentialCaseId,
  getCaseIdNumber,
  isAdminOpenid,
  normalizeCloudFileIds,
  normalizePage,
  normalizePageSize,
  normalizeVisibilityFilter,
  sanitizeCasePayload,
  trimText,
} = require("./caseAdminLogic");

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

function buildFileIdSet(records = [], field) {
  return new Set(
    records
      .map((item) => trimText(item && item[field]))
      .filter((fileID) => fileID.indexOf("cloud://") === 0)
  );
}

async function fetchCaseCoverFileIdSet(fileIDs = [], where = {}) {
  const normalizedFileIDs = normalizeCloudFileIds(fileIDs);
  if (!normalizedFileIDs.length) return new Set();
  const query = db.collection(CASE_COLLECTION).where({
    ...where,
    coverImage: _.in(normalizedFileIDs),
  });
  const response = await query
    .field({ coverImage: true })
    .limit(IMAGE_URL_BATCH_SIZE)
    .get();
  return buildFileIdSet(response.data || [], "coverImage");
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
    fetchCaseCoverFileIdSet(fileIDs, { isVisible: true }),
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

  const caseFileIds = await fetchCaseCoverFileIdSet(fileIDs);
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

  const input = event.case || event.data || {};
  const result = sanitizeCasePayload(input, { isCreate: false });
  if (!result.valid) return fail(result.code, result.message);

  await db.collection(CASE_COLLECTION).doc(id).update({
    data: {
      ...result.data,
      updatedAt: db.serverDate(),
      updatedByOpenid: openid,
    },
  });

  return ok({ id });
}

async function setCaseVisibility(event, openid) {
  const id = trimText(event.id);
  if (!id) return fail("INVALID_ID", "缺少案例 ID");

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

async function isCaseCoverImageReferenced(fileID) {
  if (!fileID || fileID.indexOf("cloud://") !== 0) return false;

  const [caseResponse, bannerResponse] = await Promise.all([
    db
      .collection(CASE_COLLECTION)
      .where({ coverImage: fileID })
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
    (caseResponse.data || []).length ||
      (bannerResponse.data || []).length
  );
}

async function deleteCase(event) {
  const id = trimText(event.id);
  if (!id) return fail("INVALID_ID", "缺少案例 ID");

  const item = await getCaseById(id);
  if (!item) return fail("CASE_NOT_FOUND", "案例不存在或已删除");

  const coverImage = trimText(item.coverImage);
  await db.collection(CASE_COLLECTION).doc(id).remove();

  const deletedFileIds = [];
  if (coverImage.indexOf("cloud://") === 0) {
    const isReferenced = await isCaseCoverImageReferenced(coverImage);
    if (!isReferenced) {
      try {
        await cloud.deleteFile({
          fileList: [coverImage],
        });
        deletedFileIds.push(coverImage);
      } catch (error) {
        console.warn("case cover file delete failed", error);
      }
    }
  }

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
