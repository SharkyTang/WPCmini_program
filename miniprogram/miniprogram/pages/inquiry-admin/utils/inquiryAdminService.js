const {
  INQUIRY_STATUS_OPTIONS,
  normalizeAdminNote,
  normalizeInquiryAdminItem,
  normalizeInquiryKeyword,
  normalizeInquiryStatus,
} = require("./inquiryAdminData");

const INQUIRY_ADMIN_FUNCTION = "inquiryAdmin";
const DEFAULT_PAGE_SIZE = 20;

function normalizeFunctionResult(response) {
  const result = (response && response.result) || {};
  if (result.ok === false) {
    const error = new Error(result.message || "需求管理请求失败");
    error.code = result.code || "INQUIRY_ADMIN_ERROR";
    throw error;
  }
  return result;
}

async function callInquiryAdmin(action, payload = {}) {
  if (!wx.cloud) {
    throw new Error("当前基础库不支持云开发");
  }

  const response = await wx.cloud.callFunction({
    name: INQUIRY_ADMIN_FUNCTION,
    data: {
      action,
      ...payload,
    },
  });
  return normalizeFunctionResult(response);
}

async function checkInquiryAdminAccess() {
  try {
    const result = await callInquiryAdmin("checkAccess");
    return Boolean(result.isAdmin);
  } catch (error) {
    console.warn("需求管理权限检查失败", error);
    return false;
  }
}

async function fetchInquiryList(options = {}) {
  const result = await callInquiryAdmin("listInquiries", {
    status: options.status || "all",
    keyword: normalizeInquiryKeyword(options.keyword),
    page: options.page || 1,
    pageSize: options.pageSize || DEFAULT_PAGE_SIZE,
  });

  return {
    items: (result.items || []).map(normalizeInquiryAdminItem),
    page: result.page || 1,
    pageSize: result.pageSize || DEFAULT_PAGE_SIZE,
    hasMore: Boolean(result.hasMore),
  };
}

async function fetchInquiryDetail(id) {
  const result = await callInquiryAdmin("getInquiry", { id });
  return normalizeInquiryAdminItem(result.item);
}

async function updateInquiryStatus(id, status) {
  const normalizedStatus = normalizeInquiryStatus(status);
  await callInquiryAdmin("updateInquiryStatus", {
    id,
    status: normalizedStatus,
  });
  return normalizedStatus;
}

async function saveInquiryNote(id, adminNote) {
  const note = normalizeAdminNote(adminNote);
  await callInquiryAdmin("saveInquiryNote", {
    id,
    adminNote: note,
  });
  return note;
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  INQUIRY_STATUS_OPTIONS,
  checkInquiryAdminAccess,
  fetchInquiryDetail,
  fetchInquiryList,
  saveInquiryNote,
  updateInquiryStatus,
};
