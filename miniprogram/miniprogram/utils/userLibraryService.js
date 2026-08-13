const USER_LIBRARY_FUNCTION = "userLibrary";

function normalizeFunctionResult(response) {
  const result = (response && response.result) || {};
  if (result.ok === false) {
    const error = new Error(result.message || "用户列表请求失败");
    error.code = result.code || "USER_LIBRARY_ERROR";
    throw error;
  }
  return result;
}

async function callUserLibrary(action, payload = {}) {
  if (!wx.cloud) {
    throw new Error("当前基础库不支持云开发");
  }
  const response = await wx.cloud.callFunction({
    name: USER_LIBRARY_FUNCTION,
    data: {
      action,
      ...payload,
    },
  });
  return normalizeFunctionResult(response);
}

function isUserLibraryUnavailableError(error) {
  const code = String((error && (error.code || error.errCode)) || "");
  const message = String((error && (error.message || error.errMsg)) || "").toLowerCase();
  return (
    code === "-501000"
    || code === "FUNCTION_NOT_FOUND"
    || message.includes("function not found")
    || message.includes("云函数不存在")
  );
}

module.exports = {
  USER_LIBRARY_FUNCTION,
  callUserLibrary,
  isUserLibraryUnavailableError,
};
