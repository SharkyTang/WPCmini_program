function getAppInstance() {
  return typeof getApp === "function" ? getApp() : null;
}

function getCachedOpenId() {
  const app = getAppInstance();
  return app && app.globalData && app.globalData.openid;
}

function cacheOpenId(openid) {
  const app = getAppInstance();
  if (!app) return;
  app.globalData = app.globalData || {};
  app.globalData.openid = openid;
}

function confirmWxIdentity() {
  return new Promise((resolve) => {
    wx.showModal({
      title: "使用微信身份",
      content: "收藏案例需要识别你的微信身份，用来保存和查看自己的收藏。",
      confirmText: "继续收藏",
      cancelText: "暂不登录",
      success(response) {
        resolve(Boolean(response.confirm));
      },
      fail() {
        resolve(false);
      },
    });
  });
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

async function ensureWxIdentity(options = {}) {
  const cachedOpenId = getCachedOpenId();
  if (cachedOpenId) return cachedOpenId;

  if (options.silent) {
    return fetchOpenId();
  }

  const confirmed = await confirmWxIdentity();
  if (!confirmed) {
    wx.showToast({
      title: "登录后可收藏案例",
      icon: "none",
    });
    return "";
  }

  try {
    return await fetchOpenId();
  } catch (error) {
    console.error("微信身份获取失败", error);
    wx.showToast({
      title: "微信身份获取失败",
      icon: "none",
    });
    return "";
  }
}

module.exports = {
  ensureWxIdentity,
  getCachedOpenId,
};
