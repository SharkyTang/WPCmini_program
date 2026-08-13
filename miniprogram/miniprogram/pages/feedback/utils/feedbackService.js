const { buildFeedbackRecord, validateFeedbackDraft } = require("./feedbackData");
const { callUserData } = require("../../../utils/userDataService");

const FEEDBACK_COLLECTION = "feedback";

function safeCall(fn, fallback) {
  try {
    return typeof fn === "function" ? fn() : fallback;
  } catch (error) {
    console.warn("反馈上下文读取失败", error);
    return fallback;
  }
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
  const deviceInfo = safeCall(wx.getDeviceInfo, {});
  const appBaseInfo = safeCall(wx.getAppBaseInfo, {});

  return normalizeSystemInfo({
    platform: deviceInfo.platform || "",
    system: deviceInfo.system || "",
    version: appBaseInfo.version || "",
    SDKVersion: appBaseInfo.SDKVersion || "",
  });
}

function getCurrentRoute() {
  const pages = typeof getCurrentPages === "function" ? getCurrentPages() : [];
  const currentPage = pages && pages.length ? pages[pages.length - 1] : null;
  return currentPage && currentPage.route ? currentPage.route : "";
}

async function submitFeedback(draft = {}, context = {}) {
  const validation = validateFeedbackDraft(draft);
  if (!validation.valid) {
    throw new Error(validation.message);
  }

  const record = buildFeedbackRecord(validation.data, {
    sourcePage: context.sourcePage || "",
    route: context.route || getCurrentRoute(),
    appVersion: context.appVersion || "v2.6",
    systemInfo: normalizeSystemInfo(context.systemInfo || getSystemInfo()),
  });

  const response = await callUserData("submitFeedback", {
    feedback: validation.data,
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
  FEEDBACK_COLLECTION,
  getSystemInfo,
  normalizeSystemInfo,
  submitFeedback,
};
