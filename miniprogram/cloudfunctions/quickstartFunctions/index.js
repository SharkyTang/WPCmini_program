const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

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

function getOpenId() {
  const wxContext = cloud.getWXContext();
  return ok({
    openid: wxContext.OPENID,
    appid: wxContext.APPID,
    unionid: wxContext.UNIONID,
  });
}

exports.main = async (event = {}) => {
  if (event.type === "getOpenId") {
    return getOpenId();
  }

  return fail("UNKNOWN_TYPE", "未知云函数操作");
};
