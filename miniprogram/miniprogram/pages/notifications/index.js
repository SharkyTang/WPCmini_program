const {
  NOTIFICATION_TYPE_KEYS,
  getNotificationTypeLabel,
  isValidSubscriptionTemplateId,
  normalizeSubscriptionState,
} = require("./utils/notificationData");
const {
  fetchPublicNotifications,
  fetchSubscriptionStatus,
  saveSubscriptionGrant,
  verifySubscriptionTemplates,
} = require("./utils/notificationService");

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

function getTemplateConfig(type, templateIds = {}, templateConfigs = {}) {
  const templateId = templateIds[type] || "";
  const serverConfig = templateConfigs[type] || {};
  const valid = serverConfig.valid === true && isValidSubscriptionTemplateId(templateId);
  const envKey = serverConfig.envKey || (
    type === "version_update"
      ? "VERSION_UPDATE_TEMPLATE_ID"
      : "PRODUCT_NEW_TEMPLATE_ID"
  );
  return {
    templateId,
    envKey,
    valid,
    message: serverConfig.message || `${envKey} 配置错误，不能填写模板编号`,
  };
}

function buildSubscriptionItems(subscriptions = {}, templateIds = {}, templateConfigs = {}) {
  const state = normalizeSubscriptionState(subscriptions);
  return NOTIFICATION_TYPE_KEYS.map((type) => {
    const config = getTemplateConfig(type, templateIds, templateConfigs);
    const item = {
      ...state[type],
      templateId: config.templateId || state[type].templateId || "",
      templateConfig: config,
    };
    return {
      ...item,
      label: `${getNotificationTypeLabel(type)}提醒`,
      actionLabel: getSubscriptionActionLabel(item),
      actionDisabled: !config.valid || item.status === "granted",
      stateText:
        !config.valid
          ? `${config.envKey} 尚未正确配置`
          : item.status === "granted"
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

function maskTemplateId(value) {
  const templateId = typeof value === "string" ? value : "";
  if (templateId.length < 8) return `length:${templateId.length}`;
  return `${templateId.slice(0, 4)}***${templateId.slice(-4)} (length:${templateId.length})`;
}

function getAuthorizationErrorMessage(error = {}) {
  const details = getErrorDetails(error);
  const source = `${details.code} ${details.message}`.toLowerCase();
  const code = Number(details.code);
  if (/tap gesture|user tap|user gesture/.test(source)) {
    return "请直接点击订阅按钮重试";
  }
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

function getTemplateVerificationMessage(result = {}, type = "") {
  const item = result.templates && result.templates[type];
  const appid = result.appid || "当前小程序";
  if (result.verificationAvailable && item && item.existsInCurrentApp === false) {
    return {
      title: "模板不属于当前小程序",
      content: `微信在 AppID ${appid} 的“我的模板”中查不到这个模板。请从该 AppID 的订阅消息页面重新复制长模板 ID，保存后重新部署 userData 和 notificationDispatcher。`,
    };
  }
  if (result.verificationAvailable && item && item.existsInCurrentApp === true) {
    return {
      title: "模板类型暂不可用",
      content: `模板“${item.title || "未命名模板"}”存在于 AppID ${appid}，但微信仍拒绝授权。请在“我的模板”中删除后重新添加一次性订阅模板，并重新复制模板 ID。`,
    };
  }
  return {
    title: "暂时无法核验模板",
    content: `${result.verificationMessage || "云端未能读取当前小程序的模板列表"}。请确认 userData 已重新部署，并检查云函数日志。`,
  };
}

async function showTemplateVerification(result, type) {
  const message = getTemplateVerificationMessage(result, type);
  if (!wx.showModal) {
    wx.showToast({ title: message.title, icon: "none" });
    return;
  }
  await new Promise((resolve) => {
    wx.showModal({
      title: message.title,
      content: message.content,
      showCancel: false,
      confirmText: "知道了",
      complete: resolve,
    });
  });
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
    templateConfigs: {},
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
        templateConfigs: subscriptionResult.templateConfigs || {},
        subscriptionItems: buildSubscriptionItems(
          subscriptionResult.subscriptions,
          subscriptionResult.templateIds,
          subscriptionResult.templateConfigs || {}
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
    const templateConfig = getTemplateConfig(
      type,
      this.data.templateIds,
      this.data.templateConfigs
    );
    const subscription = this.data.subscriptions[type] || {};
    if (!type || this.data.subscribingType) return;
    if (!templateConfig.valid) {
      console.error("订阅模板本地配置校验失败", {
        stage: "local_template_validation",
        type,
        envKey: templateConfig.envKey,
        templateId: maskTemplateId(templateId),
      });
      wx.showToast({
        title: `${templateConfig.envKey} 配置错误，不能填写模板编号`,
        icon: "none",
      });
      return;
    }

    if (subscription.status === "banned") {
      this.openSubscriptionSettings();
      return;
    }

    this.setData({ subscribingType: type });
    try {
      let response;
      try {
        // 必须在点击事件的同步调用链中立即触发，否则微信会判定缺少 TAP 手势。
        response = await new Promise((resolve, reject) => {
          wx.requestSubscribeMessage({
            tmplIds: [templateId],
            success: resolve,
            fail: reject,
          });
        });
      } catch (error) {
        const errorDetails = getErrorDetails(error);
        console.error("订阅消息授权失败", {
          stage: "wechat_authorization",
          type,
          templateId: maskTemplateId(templateId),
          ...errorDetails,
        });
        if (Number(errorDetails.code) === 20001) {
          let templateVerification = null;
          try {
            templateVerification = await verifySubscriptionTemplates();
          } catch (verificationError) {
            templateVerification = {
              verificationAvailable: false,
              verificationMessage: getErrorDetails(verificationError).message,
            };
          }
          await showTemplateVerification(templateVerification, type);
          return;
        }
        if (Number(errorDetails.code) === 20004) {
          wx.showToast({ title: "请在微信设置中开启订阅消息", icon: "none" });
          this.openSubscriptionSettings();
          return;
        }
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
        templateConfigs: result.templateConfigs || this.data.templateConfigs,
        subscriptionItems: buildSubscriptionItems(
          result.subscriptions,
          result.templateIds,
          result.templateConfigs || this.data.templateConfigs
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
