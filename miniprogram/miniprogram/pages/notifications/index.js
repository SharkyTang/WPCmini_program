const {
  NOTIFICATION_TYPE_KEYS,
  getNotificationTypeLabel,
  isNotificationTypeDisabled,
} = require("../../utils/notificationData");
const {
  fetchCustomerNotifications,
  fetchNotificationPreferences,
  fetchPublicNotifications,
  toggleNotificationPreference,
} = require("../../utils/notificationService");
const { ensureProfileIdentity, getCachedOpenId } = require("../../utils/userService");

const TAB_ITEMS = [
  { key: "all", label: "全部" },
  { key: "version_update", label: "版本更新" },
  { key: "product_new", label: "产品上新" },
  { key: "customer_reply", label: "客服回复" },
  { key: "settings", label: "通知设置" },
];

function buildSettingItems(disabledTypes = []) {
  return NOTIFICATION_TYPE_KEYS.map((type) => ({
    type,
    label: `${getNotificationTypeLabel(type)}提醒`,
    disabled: isNotificationTypeDisabled(disabledTypes, type),
  }));
}

function filterNotifications(notifications, activeTab) {
  if (activeTab === "all") return notifications;
  return notifications.filter((item) => item.type === activeTab);
}

Page({
  data: {
    tabs: TAB_ITEMS,
    activeTab: "all",
    loading: false,
    errorMessage: "",
    needCustomerIdentity: false,
    hasProfileIdentity: false,
    publicNotifications: [],
    customerNotifications: [],
    displayNotifications: [],
    disabledTypes: [],
    settingItems: buildSettingItems([]),
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
      const [publicNotifications, preferences] = await Promise.all([
        fetchPublicNotifications(),
        fetchNotificationPreferences(),
      ]);
      const customerNotifications = this.data.activeTab === "customer_reply" && getCachedOpenId()
        ? await fetchCustomerNotifications()
        : [];

      this.setData({
        loading: false,
        publicNotifications,
        customerNotifications,
        hasProfileIdentity: Boolean(preferences.hasIdentity),
        disabledTypes: preferences.disabledTypes || [],
        settingItems: buildSettingItems(preferences.disabledTypes || []),
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
    const allNotifications = [
      ...this.data.publicNotifications,
      ...this.data.customerNotifications,
    ].sort((left, right) => right.timestamp - left.timestamp);

    this.setData({
      displayNotifications: filterNotifications(allNotifications, this.data.activeTab),
      needCustomerIdentity:
        this.data.activeTab === "customer_reply" && !this.data.hasProfileIdentity,
    });
  },

  async switchTab(event) {
    const key = event.currentTarget.dataset.key;
    if (!key) return;

    this.setData({
      activeTab: key,
      errorMessage: "",
    });

    if (key === "customer_reply") {
      const identity = await ensureProfileIdentity();
      if (!identity.ready) {
        this.setData({ hasProfileIdentity: false });
        this.refreshDisplayNotifications();
        return;
      }
      this.loginAndLoadCustomer();
      return;
    }

    this.refreshDisplayNotifications();
  },

  async loginAndLoadCustomer() {
    this.setData({
      loading: true,
      errorMessage: "",
    });

    try {
      const identity = await ensureProfileIdentity();
      if (!identity.ready) {
        this.setData({ loading: false, hasProfileIdentity: false });
        this.refreshDisplayNotifications();
        return;
      }

      const customerNotifications = await fetchCustomerNotifications();
      const preferences = await fetchNotificationPreferences();
      this.setData({
        loading: false,
        customerNotifications,
        hasProfileIdentity: true,
        disabledTypes: preferences.disabledTypes || [],
        settingItems: buildSettingItems(preferences.disabledTypes || []),
      });
      this.refreshDisplayNotifications();
    } catch (error) {
      console.error("客服回复读取失败", error);
      this.setData({
        loading: false,
        errorMessage: "暂时读取不到客服回复，请稍后重试。",
      });
    }
  },

  async toggleSetting(event) {
    const type = event.currentTarget.dataset.type;
    if (!type) return;

    const identity = await ensureProfileIdentity({
      resume: () => this.applyNotificationSetting(type),
    });
    if (!identity.ready) return;

    return this.applyNotificationSetting(type);
  },

  async applyNotificationSetting(type) {
    try {
      const preferences = await toggleNotificationPreference(type);
      if (!preferences.hasIdentity) return;

      const disabledTypes = preferences.disabledTypes || [];
      this.setData({
        disabledTypes,
        settingItems: buildSettingItems(disabledTypes),
      });

      wx.showToast({
        title: isNotificationTypeDisabled(disabledTypes, type)
          ? "已关闭提醒"
          : "已开启提醒",
        icon: "none",
      });
    } catch (error) {
      console.error("通知设置保存失败", error);
      wx.showToast({
        title: "设置保存失败",
        icon: "none",
      });
    }
  },
});
