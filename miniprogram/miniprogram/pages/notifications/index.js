const {
  NOTIFICATION_TYPE_KEYS,
  getNotificationTypeLabel,
  normalizeSubscriptionState,
} = require("../../utils/notificationData");
const {
  fetchPublicNotifications,
  fetchSubscriptionStatus,
  saveSubscriptionGrant,
} = require("../../utils/notificationService");

const TAB_ITEMS = [
  { key: "all", label: "全部" },
  { key: "version_update", label: "版本更新" },
  { key: "product_new", label: "产品上新" },
  { key: "settings", label: "通知设置" },
];

function filterNotifications(notifications, activeTab) {
  if (activeTab === "all") return notifications;
  return notifications.filter((item) => item.type === activeTab);
}

function getSubscriptionActionLabel(item = {}) {
  if (!item.templateId) return "暂未配置";
  if (item.status === "granted") return "已订阅下一次";
  if (item.status === "banned") return "检查微信设置";
  return "订阅下一次";
}

function buildSubscriptionItems(subscriptions = {}, templateIds = {}) {
  const state = normalizeSubscriptionState(subscriptions);
  return NOTIFICATION_TYPE_KEYS.map((type) => {
    const item = {
      ...state[type],
      templateId: templateIds[type] || state[type].templateId || "",
    };
    return {
      ...item,
      label: `${getNotificationTypeLabel(type)}提醒`,
      actionLabel: getSubscriptionActionLabel(item),
      actionDisabled: !item.templateId || item.status === "granted",
      stateText:
        item.status === "granted"
          ? "已授权，发布下一条消息后需要重新订阅"
          : "由你主动授权，仅用于下一条对应通知",
    };
  });
}

Page({
  data: {
    tabs: TAB_ITEMS,
    activeTab: "all",
    loading: false,
    subscribingType: "",
    errorMessage: "",
    publicNotifications: [],
    displayNotifications: [],
    subscriptions: normalizeSubscriptionState({}),
    templateIds: {},
    subscriptionItems: buildSubscriptionItems(),
  },

  onShow() {
    this.loadNotifications();
  },

  async loadNotifications() {
    this.setData({
      loading: true,
      errorMessage: "",
    });

    try {
      const [publicNotifications, subscriptionResult] = await Promise.all([
        fetchPublicNotifications(),
        fetchSubscriptionStatus(),
      ]);
      this.setData({
        loading: false,
        publicNotifications,
        subscriptions: subscriptionResult.subscriptions,
        templateIds: subscriptionResult.templateIds,
        subscriptionItems: buildSubscriptionItems(
          subscriptionResult.subscriptions,
          subscriptionResult.templateIds
        ),
      });
      this.refreshDisplayNotifications();
    } catch (error) {
      console.error("消息通知读取失败", error);
      this.setData({
        loading: false,
        errorMessage: "暂时读取不到消息通知，请稍后重试。",
      });
    }
  },

  refreshDisplayNotifications() {
    this.setData({
      displayNotifications: filterNotifications(
        this.data.publicNotifications,
        this.data.activeTab
      ),
    });
  },

  switchTab(event) {
    const key = event.currentTarget.dataset.key;
    if (!key) return;
    this.setData({
      activeTab: key,
      errorMessage: "",
    });
    this.refreshDisplayNotifications();
  },

  async subscribeNext(event) {
    const type = event.currentTarget.dataset.type;
    const templateId = this.data.templateIds[type];
    const subscription = this.data.subscriptions[type] || {};
    if (!type || !templateId || this.data.subscribingType) return;

    if (subscription.status === "banned") {
      wx.openSetting({
        withSubscriptions: true,
        fail() {
          wx.showToast({ title: "请在微信设置中检查订阅消息权限", icon: "none" });
        },
      });
      return;
    }

    this.setData({ subscribingType: type });
    try {
      const response = await new Promise((resolve, reject) => {
        wx.requestSubscribeMessage({
          tmplIds: [templateId],
          success: resolve,
          fail: reject,
        });
      });
      const status = response[templateId] || "reject";
      const result = await saveSubscriptionGrant(type, templateId, status);
      this.setData({
        subscriptions: result.subscriptions,
        templateIds: result.templateIds,
        subscriptionItems: buildSubscriptionItems(
          result.subscriptions,
          result.templateIds
        ),
      });

      const title = status === "accept"
        ? "已订阅下一次提醒"
        : status === "ban"
          ? "请检查微信订阅设置"
          : "已取消，可稍后再订阅";
      wx.showToast({ title, icon: "none" });
    } catch (error) {
      console.error("订阅消息授权失败", error);
      wx.showToast({
        title: "订阅失败，请稍后重试",
        icon: "none",
      });
    } finally {
      this.setData({ subscribingType: "" });
    }
  },

  openNotification(event) {
    const targetPage = event.currentTarget.dataset.target;
    if (!targetPage || targetPage.indexOf("/pages/notifications/index") === 0) return;
    wx.navigateTo({
      url: targetPage,
      fail() {
        wx.showToast({ title: "对应内容暂时无法打开", icon: "none" });
      },
    });
  },
});
