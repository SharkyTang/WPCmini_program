const {
  INQUIRY_COLLECTION,
  buildInquiryRecord,
  validateInquiryDraft,
} = require("./inquiryData");
const { callUserData } = require("../../../utils/userDataService");

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

function normalizeSystemInfo(info = {}) {
  const source = info && typeof info === "object" ? info : {};
  const text = (value) => (typeof value === "string" ? value : "");
  return {
    platform: text(source.platform),
    system: text(source.system),
    version: text(source.version),
    SDKVersion: text(source.SDKVersion),
  };
}

function getSystemInfo() {
  const info = safeCall(wx.getSystemInfoSync, {});
  return normalizeSystemInfo(info);
}

async function submitInquiry(draft, context = {}) {
  const validation = validateInquiryDraft(draft);
  if (!validation.valid) {
    const error = new Error(validation.message);
    error.code = "INVALID_INQUIRY";
    throw error;
  }

  const record = buildInquiryRecord(validation.data, {
    source: context.source,
    sourcePage: context.sourcePage,
    route: context.route || getCurrentRoute(),
    appVersion: context.appVersion || "v2.8",
    systemInfo: normalizeSystemInfo(context.systemInfo || getSystemInfo()),
  });

  const response = await callUserData("submitInquiry", {
    inquiry: validation.data,
    source: record.source,
    sourcePage: record.sourcePage,
    route: record.route,
    appVersion: record.appVersion,
    systemInfo: record.systemInfo,
  });

  return {
    id: response.id || "",
    record,
  };
}

module.exports = {
  INQUIRY_COLLECTION,
  getSystemInfo,
  normalizeSystemInfo,
  submitInquiry,
};
