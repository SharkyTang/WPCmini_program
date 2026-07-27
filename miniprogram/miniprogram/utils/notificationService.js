const {
  NOTIFICATION_TYPE_KEYS,
  normalizeDisabledTypes,
  normalizeNotifications,
  toggleDisabledType,
} = require("./notificationData");
const { ensureWxIdentity, getCachedOpenId } = require("./userService");
const { callUserData } = require("./userDataService");

const APP_NOTIFICATION_COLLECTION = "app_notifications";
const CUSTOMER_NOTIFICATION_COLLECTION = "customer_notifications";
const NOTIFICATION_PREFERENCE_COLLECTION = "notification_preferences";

function getDb() {
  if (!wx.cloud) {
    throw new Error("当前基础库不支持云开发");
  }
  return wx.cloud.database();
}

function getCollection(name) {
  return getDb().collection(name);
}

function shouldIgnoreMissingCollection(error) {
  const message = `${(error && error.errMsg) || ""} ${(error && error.message) || ""}`;
  return /collection|not exist|DATABASE_COLLECTION_NOT_EXIST|找不到/i.test(message);
}

async function fetchPublicNotifications() {
  try {
    const response = await getCollection(APP_NOTIFICATION_COLLECTION)
      .where({
        isVisible: true,
      })
      .orderBy("createdAt", "desc")
      .limit(100)
      .get();
    return normalizeNotifications(response.data || []);
  } catch (error) {
    if (shouldIgnoreMissingCollection(error)) {
      console.warn("公共通知集合未创建", error);
      return [];
    }
    throw error;
  }
}

async function fetchCustomerNotifications(options = {}) {
  let openid = getCachedOpenId();
  if (!openid && options.requireIdentity) {
    openid = await ensureWxIdentity({
      content: "客服回复需要识别你的微信身份，用来查看发给你的消息。",
      confirmText: "查看回复",
    });
  }
  if (!openid) return [];

  try {
    const result = await callUserData("fetchCustomerNotifications");
    return normalizeNotifications(result.items || [], "customer_reply");
  } catch (error) {
    if (shouldIgnoreMissingCollection(error)) {
      console.warn("客服回复通知集合未创建", error);
      return [];
    }
    throw error;
  }
}

async function fetchNotificationPreferences(options = {}) {
  let openid = getCachedOpenId();
  if (!openid && options.requireIdentity) {
    openid = await ensureWxIdentity({
      content: "通知设置需要识别你的微信身份，用来保存你的提醒偏好。",
      confirmText: "保存设置",
    });
  }

  if (!openid) {
    return {
      hasIdentity: false,
      preferenceId: "",
      disabledTypes: [],
    };
  }

  try {
    const preference = await callUserData("fetchNotificationPreferences");
    return {
      hasIdentity: true,
      preferenceId: preference.preferenceId || "",
      disabledTypes: normalizeDisabledTypes(preference.disabledTypes || []),
    };
  } catch (error) {
    if (shouldIgnoreMissingCollection(error)) {
      console.warn("通知设置集合未创建", error);
      return {
        hasIdentity: true,
        preferenceId: "",
        disabledTypes: [],
      };
    }
    throw error;
  }
}

async function saveNotificationPreferences(preferenceId, disabledTypes) {
  const result = await callUserData("saveNotificationPreferences", {
    disabledTypes: normalizeDisabledTypes(disabledTypes),
  });
  return result.preferenceId || preferenceId || "";
}

async function toggleNotificationPreference(type) {
  if (!NOTIFICATION_TYPE_KEYS.includes(type)) {
    return fetchNotificationPreferences();
  }

  const preferences = await fetchNotificationPreferences({ requireIdentity: true });
  if (!preferences.hasIdentity) return preferences;

  const nextDisabledTypes = toggleDisabledType(preferences.disabledTypes, type);
  const preferenceId = await saveNotificationPreferences(
    preferences.preferenceId,
    nextDisabledTypes
  );

  return {
    hasIdentity: true,
    preferenceId,
    disabledTypes: nextDisabledTypes,
  };
}

module.exports = {
  APP_NOTIFICATION_COLLECTION,
  CUSTOMER_NOTIFICATION_COLLECTION,
  NOTIFICATION_PREFERENCE_COLLECTION,
  fetchPublicNotifications,
  fetchCustomerNotifications,
  fetchNotificationPreferences,
  toggleNotificationPreference,
};
