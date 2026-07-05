const {
  INQUIRY_COLLECTION,
  buildInquiryRecord,
  validateInquiryDraft,
} = require("./inquiryData");
const { getCachedOpenId } = require("./userService");

function getDb() {
  if (!wx.cloud || !wx.cloud.database) {
    throw new Error("CloudBase 数据库不可用");
  }
  return wx.cloud.database();
}

function safeCall(fn, fallback) {
  try {
    if (typeof fn !== "function") return fallback;
    return fn() || fallback;
  } catch (error) {
    return fallback;
  }
}

function getCurrentRoute() {
  const pages = safeCall(getCurrentPages, []);
  const currentPage = pages && pages[pages.length - 1];
  return currentPage && currentPage.route ? currentPage.route : "";
}

function getSystemInfo() {
  const info = safeCall(wx.getSystemInfoSync, {});
  return {
    brand: info.brand || "",
    model: info.model || "",
    platform: info.platform || "",
    system: info.system || "",
    version: info.version || "",
    SDKVersion: info.SDKVersion || "",
  };
}

async function submitInquiry(draft, context = {}) {
  const validation = validateInquiryDraft(draft);
  if (!validation.valid) {
    const error = new Error(validation.message);
    error.code = "INVALID_INQUIRY";
    throw error;
  }

  const db = getDb();
  const record = buildInquiryRecord(validation.data, {
    source: context.source,
    sourcePage: context.sourcePage,
    route: context.route || getCurrentRoute(),
    openid: context.openid || getCachedOpenId() || "",
    appVersion: context.appVersion || "v2.8",
    systemInfo: context.systemInfo || getSystemInfo(),
  });

  const response = await db.collection(INQUIRY_COLLECTION).add({
    data: {
      ...record,
      createdAt: db.serverDate(),
    },
  });

  return {
    id: response && (response._id || response.id),
    record,
  };
}

module.exports = {
  INQUIRY_COLLECTION,
  getSystemInfo,
  submitInquiry,
};
