const {
  fetchMyInquiryDetail,
  markMyInquiryRead,
  subscribeToInquiryReply,
} = require("./utils/myInquiryService");

Page({
  data: {
    id: "",
    loading: true,
    errorMessage: "",
    item: null,
    messages: [],
    replySubscription: { enabled: false, templateId: "" },
    subscribing: false,
  },

  onLoad(options = {}) {
    this.setData({ id: options.id ? decodeURIComponent(options.id) : "" });
  },

  onShow() {
    this.loadDetail();
  },

  async loadDetail() {
    if (!this.data.id) {
      this.setData({ loading: false, errorMessage: "缺少需求 ID" });
      return;
    }
    this.setData({ loading: true, errorMessage: "" });
    try {
      const messages = [];
      const messageIds = new Set();
      const usedCursors = new Set();
      let messageCursor = "";
      let item = null;
      let replySubscription = { enabled: false, templateId: "" };
      let seenThroughToken = "";
      let hasMoreMessages = true;
      while (hasMoreMessages) {
        const result = await fetchMyInquiryDetail(this.data.id, {
          messageCursor,
          messagePageSize: 50,
        });
        item = item || result.item;
        replySubscription = result.replySubscription;
        (result.messages || []).forEach((message) => {
          if (!message.id || messageIds.has(message.id)) return;
          messageIds.add(message.id);
          messages.push(message);
        });
        seenThroughToken = result.seenThroughToken || "";
        hasMoreMessages = result.hasMoreMessages;
        if (hasMoreMessages) {
          const nextCursor = result.nextMessageCursor || "";
          if (!nextCursor || usedCursors.has(nextCursor)) {
            throw new Error("回复记录分页异常，请重试");
          }
          usedCursors.add(nextCursor);
          messageCursor = nextCursor;
        }
      }
      this.setData({
        item,
        messages,
        replySubscription,
        loading: false,
      });
      if (item && item.customerUnreadCount > 0 && seenThroughToken) {
        try {
          const receipt = await markMyInquiryRead(this.data.id, seenThroughToken);
          this.setData({
            "item.customerUnreadCount": Math.max(0, Number(receipt.unreadCount) || 0),
          });
        } catch (error) {
          console.warn("需求回复已读回执失败", error);
        }
      }
    } catch (error) {
      console.error("需求详情加载失败", error);
      this.setData({ errorMessage: error.message || "需求详情加载失败" });
    } finally {
      this.setData({ loading: false });
    }
  },

  async subscribeReply() {
    if (this.data.subscribing) return;
    const { enabled, templateId } = this.data.replySubscription || {};
    if (!enabled || !templateId) {
      wx.showToast({ title: "微信提醒尚未启用，回复仍会保存在这里", icon: "none" });
      return;
    }
    this.setData({ subscribing: true });
    try {
      const result = await subscribeToInquiryReply(this.data.id, templateId);
      wx.showToast({
        title: result.accepted ? "已开启下一次回复提醒" : "未开启提醒，可稍后再试",
        icon: "none",
      });
    } catch (error) {
      console.error("需求回复订阅失败", error);
      wx.showToast({ title: error.message || "订阅失败，请稍后重试", icon: "none" });
    } finally {
      this.setData({ subscribing: false });
    }
  },

  retry() {
    this.loadDetail();
  },
});
