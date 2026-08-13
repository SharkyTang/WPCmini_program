const {
  normalizeNotifications,
  normalizeSubscriptionState,
} = require("./notificationData");
const { callUserData } = require("../../../utils/userDataService");

const APP_NOTIFICATION_COLLECTION = "app_notifications";

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

async function fetchSubscriptionStatus() {
  const result = await callUserData("fetchSubscriptionStatus");
  return {
    subscriptions: normalizeSubscriptionState(result.subscriptions || {}),
    templateIds: result.templateIds || {},
    templateConfigs: result.templateConfigs || {},
  };
}

async function verifySubscriptionTemplates() {
  return callUserData("verifySubscriptionTemplates");
}

async function saveSubscriptionGrant(type, templateId, status) {
  const result = await callUserData("saveSubscriptionGrant", {
    type,
    templateId,
    status,
  });
  return {
    subscriptions: normalizeSubscriptionState(result.subscriptions || {}),
    templateIds: result.templateIds || {},
    templateConfigs: result.templateConfigs || {},
  };
}

module.exports = {
  APP_NOTIFICATION_COLLECTION,
  fetchPublicNotifications,
  fetchSubscriptionStatus,
  saveSubscriptionGrant,
  verifySubscriptionTemplates,
};
