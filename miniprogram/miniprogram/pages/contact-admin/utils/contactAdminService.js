const CONTACT_ADMIN_FUNCTION = "contactAdmin";

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

async function saveContactAdmin(contact, revision) {
  return callContactAdmin("saveContact", {
    contact,
    revision,
  });
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

module.exports = {
  CONTACT_ADMIN_FUNCTION,
  callContactAdmin,
  checkContactAdminAccess,
  cleanupContactFiles,
  fetchContactAdminDraft,
  saveContactAdmin,
  uploadContactImage,
};
