const {
  DEFAULT_PAGE_SIZE,
  checkNotificationAdminAccess,
  fetchAnnouncementList,
  fetchDeliverySummary,
  publishAnnouncement,
  setAnnouncementVisibility,
} = require("../../utils/notificationAdminService");

Page({
  data: {
    isCheckingAccess: true,
    isAdmin: false,
    loading: false,
    loadingMore: false,
    errorMessage: "",
    items: [],
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    hasMore: false,
    confirmDialog: {
      show: false,
      title: "",
      content: "",
      buttons: [{ text: "取消" }, { text: "确认", type: "warn" }],
      action: "",
      id: "",
      sendSubscription: false,
    },
  },

  onLoad() {
    this.checkAccessAndLoad();
  },

  onShow() {
    if (this.data.isAdmin) this.loadAnnouncements({ reset: true });
  },

  async checkAccessAndLoad() {
    const isAdmin = await checkNotificationAdminAccess();
    this.setData({
      isCheckingAccess: false,
      isAdmin,
    });
    if (isAdmin) await this.loadAnnouncements({ reset: true });
  },

  async loadAnnouncements(options = {}) {
    if (!this.data.isAdmin || this.data.loading || this.data.loadingMore) return;
    const reset = options.reset === true;
    const page = reset ? 1 : this.data.page + 1;
    this.setData({
      loading: reset,
      loadingMore: !reset,
      errorMessage: "",
    });
    try {
      const result = await fetchAnnouncementList({
        page,
        pageSize: this.data.pageSize,
      });
      this.setData({
        items: reset ? result.items : this.data.items.concat(result.items),
        page: result.page,
        hasMore: result.hasMore,
      });
    } catch (error) {
      console.error("通知管理列表读取失败", error);
      this.setData({ errorMessage: error.message || "通知管理列表读取失败" });
    } finally {
      this.setData({ loading: false, loadingMore: false });
      if (wx.stopPullDownRefresh) wx.stopPullDownRefresh();
    }
  },

  onPullDownRefresh() {
    this.loadAnnouncements({ reset: true });
  },

  onReachBottom() {
    if (this.data.hasMore) this.loadAnnouncements();
  },

  createAnnouncement() {
    wx.navigateTo({ url: "/pages/notification-admin/edit" });
  },

  editAnnouncement(event) {
    const id = event.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: `/pages/notification-admin/edit?id=${id}` });
  },

  requestPublish(event) {
    const id = event.currentTarget.dataset.id;
    this.setData({
      confirmDialog: {
        show: true,
        title: "发布这条通知？",
        content: "发布后所有用户可在消息页查看，同时向已授权用户发送微信订阅提醒。",
        buttons: [{ text: "取消" }, { text: "发布", type: "warn" }],
        action: "publish",
        id,
        sendSubscription: true,
      },
    });
  },

  requestVisibility(event) {
    const id = event.currentTarget.dataset.id;
    const isVisible = event.currentTarget.dataset.visible === true
      || event.currentTarget.dataset.visible === "true";
    this.setData({
      confirmDialog: {
        show: true,
        title: isVisible ? "重新显示通知？" : "隐藏这条通知？",
        content: isVisible
          ? "重新显示后，所有用户可在消息页查看。"
          : "隐藏后前台不再显示，但后台记录仍会保留。",
        buttons: [{ text: "取消" }, { text: "确认", type: "warn" }],
        action: "visibility",
        id,
        isVisible,
      },
    });
  },

  async handleConfirmDialogTap(event) {
    const confirmed = event.detail.index === 1;
    const dialog = this.data.confirmDialog;
    this.setData({ "confirmDialog.show": false });
    if (!confirmed || !dialog.id) return;

    try {
      if (dialog.action === "publish") {
        await publishAnnouncement(dialog.id, dialog.sendSubscription);
        wx.showToast({ title: "已发布", icon: "none" });
      } else if (dialog.action === "visibility") {
        await setAnnouncementVisibility(dialog.id, dialog.isVisible);
        wx.showToast({ title: dialog.isVisible ? "已显示" : "已隐藏", icon: "none" });
      }
      await this.loadAnnouncements({ reset: true });
    } catch (error) {
      console.error("通知状态更新失败", error);
      wx.showToast({ title: error.message || "操作失败", icon: "none" });
    }
  },

  async showDeliverySummary(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    try {
      const summary = await fetchDeliverySummary(id);
      const statusLabels = {
        not_requested: "未请求推送",
        pending: "等待发送",
        processing: "发送中",
        completed: "发送完成",
        partial_failed: "部分失败",
      };
      wx.showModal({
        title: "订阅消息发送统计",
        content: `${statusLabels[summary.status] || summary.status}\n成功 ${summary.successCount || 0}，失败 ${summary.failedCount || 0}，跳过 ${summary.skippedCount || 0}`,
        showCancel: false,
      });
    } catch (error) {
      wx.showToast({ title: "统计读取失败", icon: "none" });
    }
  },
});
