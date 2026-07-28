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

function getErrorDetails(error = {}) {
  return {
    code: error.errCode || error.code || "",
    message: error.errMsg || error.message || "",
  };
}

function getAuthorizationErrorMessage(error = {}) {
  const details = getErrorDetails(error);
  const source = `${details.code} ${details.message}`.toLowerCase();
  const code = Number(details.code);
  if (
    [10001, 10002, 10003, 20001, 20002, 20003].includes(code)
    || /template|tmplid|invalid.*id/.test(source)
  ) {
    return "订阅模板配置无效，请联系管理员";
  }
  if (
    code === 20004
    || /main.?switch|switch.?off|permission|auth deny|ban/.test(source)
  ) {
    return "请在微信设置中开启订阅消息";
  }
  if (code === 20005) {
    return "当前小程序暂不能使用订阅消息";
  }
  if (/frequen|too many|limit/.test(source)) {
    return "操作过于频繁，请稍后再试";
  }
  if (/not support|unsupported|version/.test(source)) {
    return "当前微信版本不支持，请升级后重试";
  }
  return details.code
    ? `订阅授权失败（${details.code}）`
    : "订阅授权失败，请稍后重试";
}

function getGrantSaveErrorMessage(error = {}) {
  const details = getErrorDetails(error);
  if (details.code === "INVALID_TEMPLATE") {
    return "微信已授权，但云端模板配置不匹配";
  }
  if (details.code === "SERVER_ERROR") {
    return "微信已授权，但订阅状态保存失败";
  }
  return "微信已授权，但云端保存失败";
}

async function requestSubscriptionSettings() {
  if (!wx.getSetting) return {};
  try {
    return await new Promise((resolve, reject) => {
      wx.getSetting({
        withSubscriptions: true,
        success: resolve,
        fail: reject,
      });
    });
  } catch (error) {
    console.warn("读取微信订阅设置失败，将继续请求授权", error);
    return {};
  }
}

async function saveSubscriptionGrantWithRetry(type, templateId, status) {
  try {
    return await saveSubscriptionGrant(type, templateId, status);
  } catch (firstError) {
    console.warn("订阅状态首次保存失败，准备重试", {
      stage: "cloud_save_retry",
      type,
      ...getErrorDetails(firstError),
    });
    return saveSubscriptionGrant(type, templateId, status);
  }
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

  openSubscriptionSettings() {
    wx.openSetting({
      withSubscriptions: true,
      fail() {
        wx.showToast({ title: "请在微信设置中检查订阅消息权限", icon: "none" });
      },
    });
  },

  async subscribeNext(event) {
    const type = event.currentTarget.dataset.type;
    const templateId = this.data.templateIds[type];
    const subscription = this.data.subscriptions[type] || {};
    if (!type || !templateId || this.data.subscribingType) return;

    if (subscription.status === "banned") {
      this.openSubscriptionSettings();
      return;
    }

    this.setData({ subscribingType: type });
    try {
      const settingResponse = await requestSubscriptionSettings();
      const subscriptionsSetting = settingResponse.subscriptionsSetting || {};
      const itemSettings = subscriptionsSetting.itemSettings || {};
      if (
        subscriptionsSetting.mainSwitch === false
        || itemSettings[templateId] === "reject"
        || itemSettings[templateId] === "ban"
      ) {
        wx.showToast({ title: "请先在微信设置中开启订阅消息", icon: "none" });
        this.openSubscriptionSettings();
        return;
      }

      let response;
      try {
        response = await new Promise((resolve, reject) => {
          wx.requestSubscribeMessage({
            tmplIds: [templateId],
            success: resolve,
            fail: reject,
          });
        });
      } catch (error) {
        console.error("订阅消息授权失败", {
          stage: "wechat_authorization",
          type,
          ...getErrorDetails(error),
        });
        wx.showToast({
          title: getAuthorizationErrorMessage(error),
          icon: "none",
        });
        return;
      }

      const status = response[templateId] || "reject";
      let result;
      try {
        result = await saveSubscriptionGrantWithRetry(type, templateId, status);
      } catch (error) {
        console.error("订阅状态云端保存失败", {
          stage: "cloud_save",
          type,
          status,
          ...getErrorDetails(error),
        });
        wx.showToast({
          title: getGrantSaveErrorMessage(error),
          icon: "none",
        });
        return;
      }

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
