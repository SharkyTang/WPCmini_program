const { callUserData } = require("../../../utils/userDataService");
const { subscribeToInquiryReply } = require("../../../utils/inquiryFollowupService");
const {
  normalizeInquiryMessage,
  normalizeMyInquiry,
} = require("./myInquiryData");

async function fetchMyInquirySummary() {
  const result = await callUserData("getMyInquirySummary");
  return {
    inquiryCount: Math.max(0, Number(result.inquiryCount) || 0),
    unreadCount: Math.max(0, Number(result.unreadCount) || 0),
    replySubscription: result.replySubscription || { enabled: false, templateId: "" },
  };
}

async function fetchMyInquiryList(options = {}) {
  const result = await callUserData("listMyInquiries", {
    cursor: options.cursor || "",
    pageSize: options.pageSize || 20,
  });
  return {
    items: (result.items || []).map(normalizeMyInquiry),
    nextCursor: result.nextCursor || "",
    hasMore: Boolean(result.hasMore),
  };
}

async function fetchMyInquiryDetail(id, options = {}) {
  const result = await callUserData("getMyInquiryDetail", {
    id,
    messageCursor: options.messageCursor || "",
    messagePageSize: options.messagePageSize || 50,
  });
  return {
    item: normalizeMyInquiry(result.item || {}),
    messages: (result.messages || []).map(normalizeInquiryMessage),
    nextMessageCursor: result.nextMessageCursor || "",
    hasMoreMessages: Boolean(result.hasMoreMessages),
    seenThroughToken: result.seenThroughToken || "",
    seenThroughReplyCount: Math.max(0, Number(result.seenThroughReplyCount) || 0),
    replySubscription: result.replySubscription || { enabled: false, templateId: "" },
  };
}

async function markMyInquiryRead(id, seenThroughToken) {
  return callUserData("markInquiryMessagesRead", { id, seenThroughToken });
}

module.exports = {
  fetchMyInquiryDetail,
  fetchMyInquiryList,
  fetchMyInquirySummary,
  markMyInquiryRead,
  subscribeToInquiryReply,
};
