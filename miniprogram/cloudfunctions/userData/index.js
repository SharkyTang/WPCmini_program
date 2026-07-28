const cloud = require("wx-server-sdk");
const {
  FEEDBACK_COLLECTION,
  INQUIRY_COLLECTION,
  NOTIFICATION_SUBSCRIPTION_COLLECTION,
  NOTIFICATION_TYPE_KEYS,
  buildFeedbackRecord,
  buildInquiryRecord,
  pickPreferenceRecord,
  validateSubscriptionGrant,
  validateUserProfileDraft,
  validateFeedbackDraft,
  validateInquiryDraft,
} = require("./userDataLogic");

const USER_PROFILE_COLLECTION = "user_profiles";

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();

function ok(data = {}) {
  return {
    ok: true,
    ...data,
  };
}

function fail(code, message) {
  return {
    ok: false,
    code,
    message,
  };
}

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getRequestContext(event, openid) {
  return {
    source: event.source,
    sourcePage: event.sourcePage,
    route: event.route,
    appVersion: event.appVersion,
    systemInfo: event.systemInfo,
    openid,
  };
}

async function submitInquiry(event, openid) {
  const input = event.inquiry || event.data || {};
  const validation = validateInquiryDraft(input);
  if (!validation.valid) return fail(validation.code, validation.message);

  const record = buildInquiryRecord(validation.data, getRequestContext(event, openid));
  const response = await db.collection(INQUIRY_COLLECTION).add({
    data: {
      ...record,
      createdAt: db.serverDate(),
    },
  });

  return ok({
    id: response._id || "",
  });
}

async function submitFeedback(event, openid) {
  const input = event.feedback || event.data || {};
  const validation = validateFeedbackDraft(input);
  if (!validation.valid) return fail(validation.code, validation.message);

  const record = buildFeedbackRecord(validation.data, getRequestContext(event, openid));
  const response = await db.collection(FEEDBACK_COLLECTION).add({
    data: {
      ...record,
      createdAt: db.serverDate(),
    },
  });

  return ok({
    id: response._id || "",
  });
}

function getSubscriptionTemplateIds() {
  return {
    version_update: trimText(process.env.VERSION_UPDATE_TEMPLATE_ID),
    product_new: trimText(process.env.PRODUCT_NEW_TEMPLATE_ID),
  };
}

async function findSubscription(openid, type) {
  const response = await db
    .collection(NOTIFICATION_SUBSCRIPTION_COLLECTION)
    .where({ openid, type })
    .limit(1)
    .get();
  return pickPreferenceRecord(response.data);
}

async function fetchSubscriptionStatus(openid) {
  const response = await db
    .collection(NOTIFICATION_SUBSCRIPTION_COLLECTION)
    .where({ openid })
    .limit(NOTIFICATION_TYPE_KEYS.length)
    .get();
  const subscriptions = (response.data || []).reduce((result, item) => {
    result[item.type] = {
      templateId: item.templateId || "",
      status: item.status || "idle",
    };
    return result;
  }, {});
  return ok({
    subscriptions,
    templateIds: getSubscriptionTemplateIds(),
  });
}

async function saveSubscriptionGrant(event, openid) {
  const templateIds = getSubscriptionTemplateIds();
  const validation = validateSubscriptionGrant(event, templateIds);
  if (!validation.valid) return fail(validation.code, validation.message);

  const { type, templateId, status } = validation.data;
  const subscription = await findSubscription(openid, type);
  const data = {
    openid,
    type,
    templateId,
    status,
    grantedAt: status === "granted" ? db.serverDate() : null,
    consumedAt: null,
    updatedAt: db.serverDate(),
  };

  if (subscription && (subscription._id || subscription.id)) {
    const subscriptionId = subscription._id || subscription.id;
    await db.collection(NOTIFICATION_SUBSCRIPTION_COLLECTION).doc(subscriptionId).update({
      data,
    });
  } else {
    await db.collection(NOTIFICATION_SUBSCRIPTION_COLLECTION).add({
      data: {
        ...data,
        createdAt: db.serverDate(),
      },
    });
  }
  return fetchSubscriptionStatus(openid);
}

function toProfileResponse(profile) {
  if (!profile) return null;
  return {
    nickname: trimText(profile.nickname),
    avatarFileId: trimText(profile.avatarFileId),
  };
}

async function findUserProfile(openid) {
  const response = await db
    .collection(USER_PROFILE_COLLECTION)
    .where({ openid })
    .limit(1)
    .get();
  return (response.data || [])[0] || null;
}

async function getUserProfile(openid) {
  const profile = await findUserProfile(openid);
  return ok({
    profile: toProfileResponse(profile),
  });
}

async function saveUserProfile(event, openid) {
  const validation = validateUserProfileDraft(event.profile || event.data || {});
  if (!validation.valid) return fail(validation.code, validation.message);

  const existing = await findUserProfile(openid);
  const data = {
    ...validation.data,
    openid,
    updatedAt: db.serverDate(),
  };

  if (existing && existing._id) {
    await db.collection(USER_PROFILE_COLLECTION).doc(existing._id).update({ data });
    return ok({
      profile: validation.data,
    });
  }

  await db.collection(USER_PROFILE_COLLECTION).add({
    data: {
      ...data,
      createdAt: db.serverDate(),
    },
  });
  return ok({
    profile: validation.data,
  });
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const action = trimText(event.action);

  if (!OPENID) {
    return fail("UNAUTHORIZED", "未获取到微信身份");
  }

  try {
    if (action === "submitInquiry") return submitInquiry(event, OPENID);
    if (action === "submitFeedback") return submitFeedback(event, OPENID);
    if (action === "fetchSubscriptionStatus") return fetchSubscriptionStatus(OPENID);
    if (action === "saveSubscriptionGrant") return saveSubscriptionGrant(event, OPENID);
    if (action === "getProfile") return getUserProfile(OPENID);
    if (action === "saveProfile") return saveUserProfile(event, OPENID);
    return fail("UNKNOWN_ACTION", "未知用户数据操作");
  } catch (error) {
    console.error("userData error", error);
    return fail("SERVER_ERROR", error.message || "用户数据服务异常");
  }
};
