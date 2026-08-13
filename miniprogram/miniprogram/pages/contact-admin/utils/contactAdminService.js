const CONTACT_ADMIN_FUNCTION = "contactAdmin";
const STORE_IMAGE_COMPRESSION_THRESHOLD_BYTES = 768 * 1024;
const STORE_IMAGE_COMPRESSION_QUALITY = 80;

function normalizeFunctionResult(response) {
  const result = (response && response.result) || {};
  if (result.ok === false) {
    const error = new Error(result.message || "联系信息管理请求失败");
    error.code = result.code || "CONTACT_ADMIN_ERROR";
    throw error;
  }
  return result;
}

async function callContactAdmin(action, payload = {}) {
  if (!wx.cloud) {
    throw new Error("当前基础库不支持云开发");
  }
  const response = await wx.cloud.callFunction({
    name: CONTACT_ADMIN_FUNCTION,
    data: {
      action,
      ...payload,
    },
  });
  return normalizeFunctionResult(response);
}

async function checkContactAdminAccess() {
  const result = await callContactAdmin("checkAccess");
  return Boolean(result.isAdmin);
}

async function fetchContactAdminDraft() {
  return callContactAdmin("getContactDraft");
}

async function saveContactAdmin(contact, revision, clientStoreImageLimit) {
  const payload = {
    contact,
    revision,
  };
  if (
    Number.isInteger(clientStoreImageLimit) &&
    clientStoreImageLimit > 0
  ) {
    payload.clientStoreImageLimit = clientStoreImageLimit;
  }
  return callContactAdmin("saveContact", payload);
}

async function cleanupContactFiles(fileIDs = []) {
  const uniqueFileIDs = Array.from(
    new Set(
      fileIDs.filter(
        (fileID) =>
          typeof fileID === "string" && fileID.indexOf("cloud://") === 0
      )
    )
  );
  if (!uniqueFileIDs.length) return [];
  const result = await callContactAdmin("cleanupUnreferencedFiles", {
    fileIDs: uniqueFileIDs,
  });
  return result.deletedFileIds || [];
}

async function uploadContactImage({ filePath, cloudPath }) {
  if (!wx.cloud) {
    throw new Error("当前基础库不支持云开发");
  }
  if (!filePath || !cloudPath) {
    throw new Error("缺少上传图片路径");
  }
  const response = await wx.cloud.uploadFile({
    filePath,
    cloudPath,
  });
  if (!response || !response.fileID) {
    throw new Error("图片上传结果无效");
  }
  return response.fileID;
}

function prepareContactImageForUpload({
  filePath,
  kind,
  byteSize = 0,
}) {
  const shouldCompress =
    kind === "store" &&
    Number(byteSize) > STORE_IMAGE_COMPRESSION_THRESHOLD_BYTES &&
    typeof wx.compressImage === "function";

  if (!shouldCompress) {
    return Promise.resolve(filePath);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (nextPath) => {
      if (settled) return;
      settled = true;
      resolve(nextPath || filePath);
    };

    try {
      wx.compressImage({
        src: filePath,
        quality: STORE_IMAGE_COMPRESSION_QUALITY,
        success(result) {
          finish(result && result.tempFilePath);
        },
        // 压缩只是优化步骤，失败时继续上传原图，不阻断保存。
        fail() {
          finish(filePath);
        },
      });
    } catch (error) {
      finish(filePath);
    }
  });
}

module.exports = {
  CONTACT_ADMIN_FUNCTION,
  STORE_IMAGE_COMPRESSION_QUALITY,
  STORE_IMAGE_COMPRESSION_THRESHOLD_BYTES,
  callContactAdmin,
  checkContactAdminAccess,
  cleanupContactFiles,
  fetchContactAdminDraft,
  prepareContactImageForUpload,
  saveContactAdmin,
  uploadContactImage,
};
