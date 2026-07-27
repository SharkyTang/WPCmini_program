const cloud = require("wx-server-sdk");
const {
  CUSTOMER_NOTIFICATION_COLLECTION,
  FEEDBACK_COLLECTION,
  INQUIRY_COLLECTION,
  NOTIFICATION_PREFERENCE_COLLECTION,
  buildFeedbackRecord,
  buildInquiryRecord,
  normalizeDisabledTypes,
  pickPreferenceRecord,
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

async function fetchCustomerNotifications(openid) {
  const response = await db
    .collection(CUSTOMER_NOTIFICATION_COLLECTION)
    .where({
      targetOpenId: openid,
      isVisible: true,
    })
    .orderBy("createdAt", "desc")
    .limit(100)
    .get();

  return ok({
    items: response.data || [],
  });
}

async function findNotificationPreference(openid) {
  const byOpenid = await db
    .collection(NOTIFICATION_PREFERENCE_COLLECTION)
    .where({ openid })
    .limit(1)
    .get();
  const openidRecord = pickPreferenceRecord(byOpenid.data);
  if (openidRecord) return openidRecord;

  const byOwner = await db
    .collection(NOTIFICATION_PREFERENCE_COLLECTION)
    .where({ _openid: openid })
    .limit(1)
    .get();
  return pickPreferenceRecord(byOwner.data);
}

async function fetchNotificationPreferences(openid) {
  const preference = await findNotificationPreference(openid);
  return ok({
    preferenceId: preference ? preference._id || preference.id || "" : "",
    disabledTypes: normalizeDisabledTypes(preference ? preference.disabledTypes : []),
  });
}

async function saveNotificationPreferences(event, openid) {
  const preference = await findNotificationPreference(openid);
  const data = {
    openid,
    disabledTypes: normalizeDisabledTypes(event.disabledTypes || []),
    updatedAt: db.serverDate(),
  };

  if (preference && (preference._id || preference.id)) {
    const preferenceId = preference._id || preference.id;
    await db.collection(NOTIFICATION_PREFERENCE_COLLECTION).doc(preferenceId).update({
      data,
    });
    return ok({ preferenceId });
  }

  const response = await db.collection(NOTIFICATION_PREFERENCE_COLLECTION).add({
    data: {
      ...data,
      createdAt: db.serverDate(),
    },
  });
  return ok({
    preferenceId: response._id || "",
  });
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
    if (action === "fetchCustomerNotifications") return fetchCustomerNotifications(OPENID);
    if (action === "fetchNotificationPreferences") return fetchNotificationPreferences(OPENID);
    if (action === "saveNotificationPreferences") {
      return saveNotificationPreferences(event, OPENID);
    }
    if (action === "getProfile") return getUserProfile(OPENID);
    if (action === "saveProfile") return saveUserProfile(event, OPENID);
    return fail("UNKNOWN_ACTION", "未知用户数据操作");
  } catch (error) {
    console.error("userData error", error);
    return fail("SERVER_ERROR", error.message || "用户数据服务异常");
  }
};
