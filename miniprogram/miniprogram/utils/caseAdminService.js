const {
  CASE_ADMIN_VIEW_OPTIONS,
  CASE_ADMIN_VISIBILITY_OPTIONS,
  normalizeCaseAdminItem,
  normalizeCaseAdminHomepageDisplayItem,
  normalizeCaseAdminKeyword,
} = require("./caseAdminData");
const { clearCloudDataCache } = require("./cloudData");
const { markCaseDataStale } = require("./caseRefresh");

const CASE_ADMIN_FUNCTION = "caseAdmin";
const DEFAULT_PAGE_SIZE = 20;
const TEMP_FILE_URL_BATCH_SIZE = 50;

function normalizeFunctionResult(response) {
  const result = (response && response.result) || {};
  if (result.ok === false) {
    const error = new Error(result.message || "案例管理请求失败");
    error.code = result.code || "CASE_ADMIN_ERROR";
    throw error;
  }
  return result;
}

async function callCaseAdmin(action, payload = {}) {
  if (!wx.cloud) {
    throw new Error("当前基础库不支持云开发");
  }

  const response = await wx.cloud.callFunction({
    name: CASE_ADMIN_FUNCTION,
    data: {
      action,
      ...payload,
    },
  });
  return normalizeFunctionResult(response);
}

function isCloudFileId(value) {
  return typeof value === "string" && value.indexOf("cloud://") === 0;
}

function chunkList(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function getTempUrlMap(fileIds) {
  const uniqueFileIds = Array.from(new Set(fileIds.filter(isCloudFileId)));
  if (!uniqueFileIds.length) return {};

  try {
    const responses = await Promise.all(
      chunkList(uniqueFileIds, TEMP_FILE_URL_BATCH_SIZE).map((fileList) =>
        callCaseAdmin("getCaseImageUrls", { fileIDs: fileList })
      )
    );
    return responses.reduce((map, result) => {
      const urls = result.urls || {};
      Object.keys(urls).forEach((fileID) => {
        map[fileID] = urls[fileID];
      });
      return map;
    }, {});
  } catch (error) {
    console.warn("案例管理图片临时链接云函数获取失败，将尝试客户端兼容方式", error);
    if (!wx.cloud.getTempFileURL) return {};
    try {
      const responses = await Promise.all(
        chunkList(uniqueFileIds, TEMP_FILE_URL_BATCH_SIZE).map((fileList) =>
          wx.cloud.getTempFileURL({ fileList })
        )
      );
      return responses.reduce((map, response) => {
        (response.fileList || []).forEach((item) => {
          if (item && item.fileID && item.tempFileURL) {
            map[item.fileID] = item.tempFileURL;
          }
        });
        return map;
      }, {});
    } catch (fallbackError) {
      console.warn("案例管理图片临时链接客户端兼容方式失败，请确认 caseAdmin 云函数已部署", fallbackError);
      return {};
    }
  }
}

async function getVisibleTempUrlMap(fileIds) {
  const uniqueFileIds = Array.from(new Set(fileIds.filter(isCloudFileId)));
  if (!uniqueFileIds.length) return {};

  try {
    const responses = await Promise.all(
      chunkList(uniqueFileIds, TEMP_FILE_URL_BATCH_SIZE).map((fileList) =>
        callCaseAdmin("getVisibleImageUrls", { fileIDs: fileList })
      )
    );
    return responses.reduce((map, result) => ({ ...map, ...(result.urls || {}) }), {});
  } catch (error) {
    console.warn("首页展示图片临时链接获取失败，将尝试客户端兼容方式", error);
    if (!wx.cloud.getTempFileURL) return {};
    try {
      const responses = await Promise.all(
        chunkList(uniqueFileIds, TEMP_FILE_URL_BATCH_SIZE).map((fileList) =>
          wx.cloud.getTempFileURL({ fileList })
        )
      );
      return responses.reduce((map, response) => {
        (response.fileList || []).forEach((item) => {
          if (item && item.fileID && item.tempFileURL) map[item.fileID] = item.tempFileURL;
        });
        return map;
      }, {});
    } catch (fallbackError) {
      console.warn("首页展示图片客户端兼容方式失败", fallbackError);
      return {};
    }
  }
}

function resolveCaseCoverUrl(fileID, tempUrlMap = {}) {
  return tempUrlMap[fileID] || (isCloudFileId(fileID) ? "" : fileID);
}

async function attachCaseCoverUrls(cases) {
  const tempUrlMap = await getTempUrlMap(cases.map((item) => item.coverImage));
  return cases.map((item) => ({
    ...item,
    coverImageUrl: resolveCaseCoverUrl(item.coverImage, tempUrlMap),
  }));
}

async function attachCaseGalleryUrls(cases) {
  const imageFileIds = cases.flatMap((item) => (
    Array.isArray(item.galleryImages) && item.galleryImages.length
      ? item.galleryImages
      : [item.coverImage]
  ));
  const tempUrlMap = await getTempUrlMap(imageFileIds);
  return cases.map((item) => {
    const galleryImages = Array.isArray(item.galleryImages) && item.galleryImages.length
      ? item.galleryImages
      : [item.coverImage].filter(Boolean);
    const galleryImageUrls = galleryImages.map((fileID) => resolveCaseCoverUrl(fileID, tempUrlMap));
    return {
      ...item,
      galleryImages,
      galleryImageUrls,
      coverImageUrl: galleryImageUrls[0] || item.coverImageUrl || "",
    };
  });
}

async function attachHomepageDisplayImageUrls(items) {
  const tempUrlMap = await getVisibleTempUrlMap(
    items.map((item) => item.coverImage || item.image)
  );
  return items.map((item) => {
    const image = item.coverImage || item.image;
    return {
      ...item,
      coverImageUrl: resolveCaseCoverUrl(image, tempUrlMap),
    };
  });
}

async function checkCaseAdminAccess() {
  try {
    const result = await callCaseAdmin("checkAccess");
    return Boolean(result.isAdmin);
  } catch (error) {
    console.warn("案例管理权限检查失败", error);
    return false;
  }
}

async function fetchCaseAdminList(options = {}) {
  const result = await callCaseAdmin("listCases", {
    visibility: options.visibility || "all",
    keyword: normalizeCaseAdminKeyword(options.keyword),
    page: options.page || 1,
    pageSize: options.pageSize || DEFAULT_PAGE_SIZE,
  });
  const items = (result.items || []).map(normalizeCaseAdminItem);

  return {
    items: await attachCaseCoverUrls(items),
    page: result.page || 1,
    pageSize: result.pageSize || DEFAULT_PAGE_SIZE,
    hasMore: Boolean(result.hasMore),
  };
}

async function fetchCaseAdminHomepageDisplay(options = {}) {
  const result = await callCaseAdmin("listHomepageDisplay", {
    slot: options.slot,
    keyword: normalizeCaseAdminKeyword(options.keyword),
  });
  const items = (result.items || []).map(normalizeCaseAdminHomepageDisplayItem);
  return {
    items: await attachHomepageDisplayImageUrls(items),
    slot: result.slot || options.slot || "",
  };
}

async function fetchCaseAdminDetail(id) {
  const result = await callCaseAdmin("getCase", { id });
  const item = normalizeCaseAdminItem(result.item);
  const items = await attachCaseGalleryUrls(item ? [item] : []);
  return items[0] || null;
}

function markCaseDataChanged() {
  markCaseDataStale();
  clearCloudDataCache();
}

async function createCaseAdmin(caseData) {
  const result = await callCaseAdmin("createCase", { case: caseData });
  markCaseDataChanged();
  return result;
}

async function updateCaseAdmin(id, caseData) {
  const result = await callCaseAdmin("updateCase", { id, case: caseData });
  markCaseDataChanged();
  return result;
}

async function setCaseVisibility(id, isVisible) {
  const result = await callCaseAdmin("setCaseVisibility", { id, isVisible });
  markCaseDataChanged();
  return result;
}

async function deleteCaseAdmin(id) {
  const result = await callCaseAdmin("deleteCase", { id });
  markCaseDataChanged();
  return result;
}

async function uploadCaseCoverImage(input, maybeCloudPath) {
  const filePath = typeof input === "object" && input ? input.filePath : input;
  const cloudPath = typeof input === "object" && input ? input.cloudPath : maybeCloudPath;

  if (!wx.cloud) {
    throw new Error("当前基础库不支持云开发");
  }
  if (!filePath || !cloudPath) {
    throw new Error("缺少上传图片路径");
  }

  const response = await wx.cloud.uploadFile({
    cloudPath,
    filePath,
  });
  return response.fileID;
}

module.exports = {
  CASE_ADMIN_VIEW_OPTIONS,
  CASE_ADMIN_VISIBILITY_OPTIONS,
  DEFAULT_PAGE_SIZE,
  checkCaseAdminAccess,
  createCaseAdmin,
  deleteCaseAdmin,
  fetchCaseAdminDetail,
  fetchCaseAdminHomepageDisplay,
  fetchCaseAdminList,
  attachCaseGalleryUrls,
  setCaseVisibility,
  updateCaseAdmin,
  uploadCaseCoverImage,
};
