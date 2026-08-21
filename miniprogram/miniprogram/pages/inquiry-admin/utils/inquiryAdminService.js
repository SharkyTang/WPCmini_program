const {
  INQUIRY_STATUS_OPTIONS,
  buildInquiryTimeline,
  normalizeAdminNote,
  normalizeClaim,
  normalizeContactType,
  normalizeInquiryAdminItem,
  normalizeInquiryKeyword,
  normalizeInquiryMessage,
  normalizeInquiryStatus,
  normalizeInquirySummary,
  normalizeReplyContent,
} = require("./inquiryAdminData");

const INQUIRY_ADMIN_FUNCTION = "inquiryAdmin";
const DEFAULT_PAGE_SIZE = 20;

function getCurrentAdminOpenid() {
  if (typeof getApp !== "function") return "";
  const app = getApp();
  return app && app.globalData && typeof app.globalData.openid === "string"
    ? app.globalData.openid.trim()
    : "";
}

function normalizeFunctionResult(response) {
  const result = response && Object.prototype.hasOwnProperty.call(response, "result")
    ? response.result || {}
    : response || {};
  if (result.ok === false) {
    const error = new Error(result.message || "需求管理请求失败");
    error.code = result.code || "INQUIRY_ADMIN_ERROR";
    error.details = result;
    if (result.claim) error.claim = normalizeClaim({ claim: result.claim });
    throw error;
  }
  return result;
}

async function callInquiryAdmin(action, payload = {}) {
  if (!wx.cloud) throw new Error("当前基础库不支持云开发");
  const response = await wx.cloud.callFunction({
    name: INQUIRY_ADMIN_FUNCTION,
    data: { action, ...payload },
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

async function fetchInquirySummary() {
  const result = await callInquiryAdmin("getInquirySummary");
  return normalizeInquirySummary(result.summary || result);
}

async function fetchInquiryList(options = {}) {
  const result = await callInquiryAdmin("listInquiries", {
    status: options.status || "all",
    filter: options.filter || "all",
    keyword: normalizeInquiryKeyword(options.keyword),
    cursor: typeof options.cursor === "string" ? options.cursor : "",
    page: options.page || 1,
    pageSize: options.pageSize || DEFAULT_PAGE_SIZE,
  });
  const currentOpenid = getCurrentAdminOpenid();
  const items = Array.isArray(result.items)
    ? result.items
    : Array.isArray(result.list)
      ? result.list
      : [];
  return {
    items: items.map((item) => normalizeInquiryAdminItem(item, { currentOpenid })),
    page: Number(result.page) > 0 ? Number(result.page) : 1,
    pageSize: Number(result.pageSize) > 0 ? Number(result.pageSize) : DEFAULT_PAGE_SIZE,
    nextCursor: typeof result.nextCursor === "string" ? result.nextCursor : "",
    hasMore: Boolean(result.hasMore),
  };
}

async function fetchInquiryDetail(id) {
  const result = await callInquiryAdmin("getInquiry", { id });
  const rawItem = result.item || result.inquiry || result;
  const rawMessages = Array.isArray(result.messages)
    ? result.messages
    : Array.isArray(rawItem.messages)
      ? rawItem.messages
      : [];
  const item = normalizeInquiryAdminItem(rawItem, {
    currentOpenid: getCurrentAdminOpenid(),
  });
  const messages = rawMessages.map(normalizeInquiryMessage);
  return {
    item,
    messages,
    timeline: buildInquiryTimeline(item, messages),
  };
}

async function updateInquiryStatus(id, status) {
  const normalizedStatus = normalizeInquiryStatus(status);
  await callInquiryAdmin("updateInquiryStatus", { id, status: normalizedStatus });
  return normalizedStatus;
}

async function saveInquiryNote(id, adminNote) {
  const note = normalizeAdminNote(adminNote);
  await callInquiryAdmin("saveInquiryNote", { id, adminNote: note });
  return note;
}

function normalizeClaimMutationResult(result = {}) {
  return {
    id: typeof result.id === "string" ? result.id : "",
    claim: normalizeClaim({ claim: result.claim }, { currentOpenid: getCurrentAdminOpenid() }),
    idempotent: Boolean(result.idempotent),
    takenOver: Boolean(result.takenOver),
    cancelledAlertJobCount: Math.max(0, Number(result.cancelledAlertJobCount) || 0),
  };
}

async function claimInquiry(id) {
  const result = await callInquiryAdmin("claimInquiry", { id });
  const normalized = normalizeClaimMutationResult(result);
  normalized.claim.isMine = true;
  normalized.claim.state = "mine";
  normalized.claim.label = "我在跟进";
  return normalized;
}

async function takeOverInquiry(id, expectedClaimedBy) {
  const result = await callInquiryAdmin("takeOverInquiry", {
    id,
    expectedClaimedBy: typeof expectedClaimedBy === "string"
      ? expectedClaimedBy.trim()
      : "",
  });
  const normalized = normalizeClaimMutationResult(result);
  normalized.claim.isMine = true;
  normalized.claim.state = "mine";
  normalized.claim.label = "我在跟进";
  return normalized;
}

function createClientMutationId() {
  const random = Math.random().toString(36).slice(2, 12) || "reply";
  return `mini-${Date.now()}-${random}`;
}

function getReplyPushNotice(pushStatus) {
  const status = typeof pushStatus === "string" ? pushStatus : "";
  if (status === "success") return { type: "success", message: "回复已发送并通知客户" };
  if (status === "failed") {
    return {
      type: "warning",
      message: "回复已保存，但客户微信通知发送失败，请通过联系方式同步客户",
    };
  }
  if (status === "no_grant") {
    return {
      type: "warning",
      message: "回复已保存；客户未授权微信通知，请通过联系方式同步客户",
    };
  }
  if (status === "disabled" || status === "no_recipient") {
    return {
      type: "warning",
      message: "回复已保存；微信通知未发送，请通过联系方式同步客户",
    };
  }
  return { type: "success", message: "回复已保存" };
}

async function replyInquiry(id, content, clientMutationId) {
  const result = await callInquiryAdmin("replyInquiry", {
    id,
    content: normalizeReplyContent(content),
    clientMutationId: clientMutationId || createClientMutationId(),
  });
  const claim = normalizeClaim({ claim: result.claim }, { currentOpenid: getCurrentAdminOpenid() });
  if (claim.isClaimed) {
    claim.isMine = true;
    claim.state = "mine";
    claim.label = "我在跟进";
  }
  return {
    id: result.id || id,
    message: normalizeInquiryMessage(result.message || {}),
    status: normalizeInquiryStatus(result.status),
    claim,
    idempotent: Boolean(result.idempotent),
    pushStatus: typeof result.pushStatus === "string" ? result.pushStatus : "",
    pushNotice: getReplyPushNotice(result.pushStatus),
  };
}

async function correctContactType(id, contactType) {
  const normalizedContactType = normalizeContactType(contactType);
  const result = await callInquiryAdmin("correctContactType", {
    id,
    contactType: normalizedContactType,
  });
  return {
    id: result.id || id,
    contactType: normalizeContactType(result.contactType || normalizedContactType),
    previousContactType: normalizeContactType(result.previousContactType),
    idempotent: Boolean(result.idempotent),
  };
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  INQUIRY_STATUS_OPTIONS,
  callInquiryAdmin,
  checkInquiryAdminAccess,
  claimInquiry,
  correctContactType,
  createClientMutationId,
  fetchInquiryDetail,
  fetchInquiryList,
  fetchInquirySummary,
  getReplyPushNotice,
  normalizeFunctionResult,
  replyInquiry,
  saveInquiryNote,
  takeOverInquiry,
  updateInquiryStatus,
};
