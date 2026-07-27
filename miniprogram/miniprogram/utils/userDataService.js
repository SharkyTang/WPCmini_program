const USER_DATA_FUNCTION = "userData";

function normalizeFunctionResult(response) {
  const result = (response && response.result) || {};
  if (result.ok === false) {
    const error = new Error(result.message || "用户数据请求失败");
    error.code = result.code || "USER_DATA_ERROR";
    throw error;
  }
  return result;
}

async function callUserData(action, payload = {}) {
  if (!wx.cloud) {
    throw new Error("当前基础库不支持云开发");
  }

  const response = await wx.cloud.callFunction({
    name: USER_DATA_FUNCTION,
    data: {
      action,
      ...payload,
    },
  });
  return normalizeFunctionResult(response);
}

module.exports = {
  USER_DATA_FUNCTION,
  callUserData,
};
