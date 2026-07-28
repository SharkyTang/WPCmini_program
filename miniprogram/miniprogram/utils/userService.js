const {
  fetchSessionSummary,
  hasCompletedProfile,
} = require("./profileService");

let profileVerificationPromise = null;
let profileSetupNavigationInProgress = false;
let skipNextProfileSetupRedirect = false;
let pendingProfileAction = null;
let verifiedProfileIdentity = null;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAppInstance() {
  return typeof getApp === "function" ? getApp() : null;
}

function getCachedOpenId() {
  const app = getAppInstance();
  return app && app.globalData && app.globalData.openid;
}

function cacheOpenId(openid) {
  if (!openid) return;
  const app = getAppInstance();
  if (!app) return;
  app.globalData = app.globalData || {};
  app.globalData.openid = openid;
}

async function fetchOpenId() {
  const response = await wx.cloud.callFunction({
    name: "quickstartFunctions",
    data: {
      type: "getOpenId",
    },
  });
  const openid = response && response.result && response.result.openid;
  if (!openid) {
    throw new Error("未获取到微信身份");
  }
  cacheOpenId(openid);
  return openid;
}

async function ensureWxIdentity() {
  return getCachedOpenId() || fetchOpenId();
}

function getProfileSetupUrl() {
  return "/pages/profile/edit/index?mode=setup&identityGate=1";
}

function setPendingProfileAction(action) {
  pendingProfileAction = typeof action === "function" ? action : null;
}

function clearPendingProfileAction(options = {}) {
  pendingProfileAction = null;
  profileSetupNavigationInProgress = false;
  if (options.dismissed) skipNextProfileSetupRedirect = true;
}

function resumePendingProfileAction() {
  const action = pendingProfileAction;
  pendingProfileAction = null;
  profileSetupNavigationInProgress = false;
  skipNextProfileSetupRedirect = false;
  if (!action) return Promise.resolve();

  try {
    return Promise.resolve(action()).catch((error) => {
      console.error("恢复个人资料后的操作失败", error);
    });
  } catch (error) {
    console.error("恢复个人资料后的操作失败", error);
    return Promise.resolve();
  }
}

async function verifyProfileIdentity() {
  const cachedOpenId = getCachedOpenId();
  if (cachedOpenId && verifiedProfileIdentity && verifiedProfileIdentity.openid === cachedOpenId) {
    return verifiedProfileIdentity;
  }

  if (!profileVerificationPromise) {
    profileVerificationPromise = (async () => {
      let summary;
      try {
        summary = await fetchSessionSummary();
      } catch (firstError) {
        await wait(250);
        summary = await fetchSessionSummary({ forceRefresh: true });
      }
      const openid = summary.openid || getCachedOpenId() || await fetchOpenId();
      const profile = summary.profile || null;
      cacheOpenId(openid);
      const identity = {
        openid,
        profile,
        ready: hasCompletedProfile(profile),
      };
      if (identity.ready) verifiedProfileIdentity = identity;
      return identity;
    })();
  }

  try {
    return await profileVerificationPromise;
  } finally {
    profileVerificationPromise = null;
  }
}

function cacheCompletedProfileIdentity(openid, profile) {
  if (!openid || !hasCompletedProfile(profile)) return;
  verifiedProfileIdentity = {
    openid,
    profile,
    ready: true,
  };
}

function showProfileCheckError() {
  if (!wx.showToast) return;
  wx.showToast({
    title: "暂时无法验证资料，请重试",
    icon: "none",
  });
}

function navigateToProfileSetup() {
  if (profileSetupNavigationInProgress || !wx.navigateTo) return;
  profileSetupNavigationInProgress = true;
  wx.navigateTo({
    url: getProfileSetupUrl(),
    fail(error) {
      console.error("跳转完善资料页失败", error);
      profileSetupNavigationInProgress = false;
      showProfileCheckError();
    },
  });
}

async function ensureProfileIdentity(options = {}) {
  const redirectToSetup = options.redirectToSetup !== false;

  let identity;
  try {
    identity = await verifyProfileIdentity();
  } catch (error) {
    console.error("个人资料身份验证失败", error);
    if (options.showError !== false) showProfileCheckError();
    return {
      ready: false,
      error,
      openid: "",
      profile: null,
    };
  }

  if (identity.ready) return identity;

  if (!redirectToSetup) return identity;

  if (skipNextProfileSetupRedirect) {
    skipNextProfileSetupRedirect = false;
    return {
      ...identity,
      dismissed: true,
    };
  }

  setPendingProfileAction(options.resume);
  navigateToProfileSetup();
  return identity;
}

module.exports = {
  cacheCompletedProfileIdentity,
  cacheOpenId,
  clearPendingProfileAction,
  ensureProfileIdentity,
  ensureWxIdentity,
  fetchOpenId,
  getCachedOpenId,
  resumePendingProfileAction,
};
