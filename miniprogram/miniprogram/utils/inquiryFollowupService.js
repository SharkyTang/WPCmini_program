const { callUserData } = require("./userDataService");

async function fetchInquiryBadgeSummary() {
  const result = await callUserData("getInquiryBadgeSummary");
  return {
    myUnreadCount: Math.max(0, Number(result.myUnreadCount) || 0),
    adminNewCount: Math.max(0, Number(result.adminNewCount) || 0),
  };
}

function requestSubscribeMessage(templateId) {
  return new Promise((resolve, reject) => {
    if (!wx.requestSubscribeMessage) {
      reject(new Error("当前微信版本不支持订阅消息"));
      return;
    }
    wx.requestSubscribeMessage({
      tmplIds: [templateId],
      success: resolve,
      fail: reject,
    });
  });
}

async function subscribeToInquiryReply(id, templateId) {
  if (!id || !templateId) throw new Error("需求回复模板尚未启用");
  const response = await requestSubscribeMessage(templateId);
  const status = response && response[templateId];
  if (!["accept", "reject", "ban"].includes(status)) {
    throw new Error("未获取到有效订阅结果");
  }
  const saved = await callUserData("saveInquiryReplySubscription", {
    id,
    templateId,
    status,
  });
  return {
    status: saved.status,
    accepted: saved.status === "granted",
  };
}

module.exports = {
  fetchInquiryBadgeSummary,
  subscribeToInquiryReply,
};
