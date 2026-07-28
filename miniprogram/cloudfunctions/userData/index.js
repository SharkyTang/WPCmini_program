const cloud = require("wx-server-sdk");
const {
  FEEDBACK_COLLECTION,
  INQUIRY_COLLECTION,
  NOTIFICATION_SUBSCRIPTION_COLLECTION,
  NOTIFICATION_TYPE_KEYS,
  buildFeedbackRecord,
  buildInquiryRecord,
  buildTemplateConfig,
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

function getWechatTemplateId(item = {}) {
  return trimText(
    item.priTmplId
    || item.pri_tmpl_id
    || item.templateId
    || item.template_id
  );
}

function getWechatTemplateItems(response = {}) {
  const candidates = [
    response.data,
    response.priTmplList,
    response.templateList,
    response.list,
  ];
  return candidates.find(Array.isArray) || [];
}

async function verifySubscriptionTemplates(appid) {
  const templateIds = getSubscriptionTemplateIds();
  const templateConfigs = NOTIFICATION_TYPE_KEYS.reduce((result, type) => {
    result[type] = buildTemplateConfig(type, templateIds[type]);
    return result;
  }, {});

  if (
    !cloud.openapi
    || !cloud.openapi.subscribeMessage
    || typeof cloud.openapi.subscribeMessage.getTemplateList !== "function"
  ) {
    return ok({
      appid,
      verificationAvailable: false,
      verificationCode: "OPENAPI_UNAVAILABLE",
      verificationMessage: "当前 userData 云函数 SDK 不支持查询订阅模板列表，请重新部署云函数依赖",
      templates: templateConfigs,
    });
  }

  try {
    const response = await cloud.openapi.subscribeMessage.getTemplateList({});
    const templateItems = getWechatTemplateItems(response);
    const templateMap = templateItems.reduce((result, item) => {
      const id = getWechatTemplateId(item);
      if (id) result[id] = item;
      return result;
    }, {});
    const templates = NOTIFICATION_TYPE_KEYS.reduce((result, type) => {
      const config = templateConfigs[type];
      const item = templateMap[config.templateId] || null;
      result[type] = {
        ...config,
        existsInCurrentApp: Boolean(item),
        usable: config.valid && Boolean(item),
        title: item ? trimText(item.title) : "",
        templateType: item ? item.type : "",
        code: !config.valid
          ? config.code
          : item
            ? ""
            : "TEMPLATE_NOT_IN_CURRENT_APP",
        message: !config.valid
          ? config.message
          : item
            ? ""
            : `${config.envKey} 对应模板不在当前 AppID 的“我的模板”列表中`,
      };
      return result;
    }, {});
    return ok({
      appid,
      verificationAvailable: true,
      templateCount: templateItems.length,
      templates,
    });
  } catch (error) {
    console.error("subscription template verification error", {
      appid,
      code: error.errCode || error.code || "",
      message: error.errMsg || error.message || "",
    });
    return ok({
      appid,
      verificationAvailable: false,
      verificationCode: error.errCode || error.code || "OPENAPI_ERROR",
      verificationMessage: error.errMsg || error.message || "微信模板列表查询失败",
      templates: templateConfigs,
    });
  }
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
  const templateIds = getSubscriptionTemplateIds();
  const templateConfigs = NOTIFICATION_TYPE_KEYS.reduce((result, type) => {
    result[type] = buildTemplateConfig(type, templateIds[type]);
    return result;
  }, {});
  const response = await db
    .collection(NOTIFICATION_SUBSCRIPTION_COLLECTION)
    .where({ openid })
    .limit(NOTIFICATION_TYPE_KEYS.length)
    .get();
  const subscriptions = (response.data || []).reduce((result, item) => {
    const currentTemplateId = templateIds[item.type] || "";
    const matchesCurrentTemplate = (
      templateConfigs[item.type]
      && templateConfigs[item.type].valid
      && item.templateId === currentTemplateId
    );
    result[item.type] = {
      templateId: matchesCurrentTemplate ? item.templateId || "" : currentTemplateId,
      status: matchesCurrentTemplate ? item.status || "idle" : "idle",
    };
    return result;
  }, {});
  return ok({
    subscriptions,
    templateIds,
    templateConfigs,
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
  const { OPENID, APPID } = cloud.getWXContext();
  const action = trimText(event.action);

  if (!OPENID) {
    return fail("UNAUTHORIZED", "未获取到微信身份");
  }

  try {
    if (action === "submitInquiry") return submitInquiry(event, OPENID);
    if (action === "submitFeedback") return submitFeedback(event, OPENID);
    if (action === "fetchSubscriptionStatus") return fetchSubscriptionStatus(OPENID);
    if (action === "verifySubscriptionTemplates") {
      return verifySubscriptionTemplates(APPID || "");
    }
    if (action === "saveSubscriptionGrant") return saveSubscriptionGrant(event, OPENID);
    if (action === "getProfile") return getUserProfile(OPENID);
    if (action === "saveProfile") return saveUserProfile(event, OPENID);
    return fail("UNKNOWN_ACTION", "未知用户数据操作");
  } catch (error) {
    console.error("userData error", error);
    return fail("SERVER_ERROR", error.message || "用户数据服务异常");
  }
};
