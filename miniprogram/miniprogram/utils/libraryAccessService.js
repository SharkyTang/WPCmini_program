const {
  LIBRARY_ACCESS_MODE,
  getLibraryAccessMode,
} = require("./libraryAccessConfig");
const {
  ensureProfileIdentity,
  ensureWxIdentity,
} = require("./userService");

const PROFILE_SETUP_URL = "/pages/profile/edit/index?mode=setup&identityGate=1";
const SOURCE_KIND_MAP = Object.freeze({
  detail_favorite: "favorites",
  profile_favorites: "favorites",
  profile_history: "history",
});
const PROFILE_SETUP_COPY = Object.freeze({
  detail_favorite: Object.freeze({
    source: "detail_favorite",
    title: "收藏当前案例",
    content: "完善头像和昵称后，可保存并跨设备查看收藏。完成后将自动返回并收藏当前案例。",
    confirmText: "去完善",
    cancelText: "暂不",
    subtitle: "完善后将自动返回并收藏当前案例",
    buttonText: "完成并收藏",
  }),
  profile_favorites: Object.freeze({
    source: "profile_favorites",
    title: "查看我的收藏",
    content: "完善头像和昵称后，可保存并跨设备查看收藏。完成后将自动进入“我的收藏”。",
    confirmText: "去完善",
    cancelText: "暂不",
    subtitle: "完善后将自动进入“我的收藏”",
    buttonText: "完成并查看",
  }),
  profile_history: Object.freeze({
    source: "profile_history",
    title: "查看浏览记录",
    content: "完善头像和昵称后，可记录并跨设备查看最近浏览的案例。完成后将自动进入“浏览记录”。",
    confirmText: "去完善",
    cancelText: "暂不",
    subtitle: "完善后将自动进入“浏览记录”",
    buttonText: "完成并查看",
  }),
});

let pendingLibraryAction = null;
let navigationInProgress = false;
let requestInFlight = null;
let pendingTokenSequence = 0;
let telemetryContext = null;

function createPendingToken() {
  pendingTokenSequence += 1;
  return `${Date.now()}-${pendingTokenSequence}`;
}

function getDurationBucket(durationMs) {
  const duration = Number(durationMs);
  if (!Number.isFinite(duration) || duration < 0) return "unknown";
  if (duration < 200) return "under_200ms";
  if (duration < 500) return "200_499ms";
  if (duration < 1000) return "500_999ms";
  if (duration < 3000) return "1000_2999ms";
  return "3000ms_plus";
}

function getTelemetryContext() {
  if (telemetryContext) return telemetryContext;
  let platform = "";
  let version = "";
  try {
    const device = wx.getDeviceInfo
      ? wx.getDeviceInfo()
      : wx.getSystemInfoSync
        ? wx.getSystemInfoSync()
        : {};
    platform = typeof device.platform === "string" ? device.platform : "";
  } catch (error) {
    platform = "";
  }
  try {
    const account = wx.getAccountInfoSync ? wx.getAccountInfoSync() : {};
    const miniProgram = account && account.miniProgram ? account.miniProgram : {};
    version = typeof miniProgram.version === "string" && miniProgram.version
      ? miniProgram.version
      : typeof miniProgram.envVersion === "string"
        ? miniProgram.envVersion
        : "";
  } catch (error) {
    version = "";
  }
  telemetryContext = { platform, version };
  return telemetryContext;
}

function reportLibraryEvent(eventName, payload = {}) {
  if (typeof wx === "undefined" || !wx.reportEvent) return false;
  const context = getTelemetryContext();
  const safePayload = {
    kind: typeof payload.kind === "string" ? payload.kind : "",
    source: typeof payload.source === "string" ? payload.source : "",
    result: typeof payload.result === "string" ? payload.result : "",
    duration_bucket: getDurationBucket(payload.durationMs),
    platform: context.platform,
    version: context.version,
  };
  try {
    wx.reportEvent(eventName, safePayload);
    return true;
  } catch (error) {
    console.warn("用户列表访问事件上报失败", error);
    return false;
  }
}

function getProfileSetupCopy(source) {
  const copy = PROFILE_SETUP_COPY[source];
  if (!copy) {
    throw new RangeError(`不支持的资料完善来源：${source || ""}`);
  }
  return copy;
}

function validateRequest(kind, source) {
  getLibraryAccessMode(kind);
  getProfileSetupCopy(source);
  if (SOURCE_KIND_MAP[source] !== kind) {
    throw new RangeError(`资料完善来源 ${source} 与用户列表类型 ${kind} 不匹配`);
  }
}

function buildAccessResult(status, mode, values = {}) {
  return {
    status,
    ready: status === "ready",
    mode,
    openid: values.openid || "",
    profile: values.profile || null,
    ...(values.stage ? { stage: values.stage } : {}),
    ...(values.error ? { error: values.error } : {}),
  };
}

async function checkLibraryAccess(kind) {
  const mode = getLibraryAccessMode(kind);
  if (mode === LIBRARY_ACCESS_MODE.OPENID) {
    try {
      const openid = await ensureWxIdentity();
      if (!openid) throw new Error("未获取到微信身份");
      return buildAccessResult("ready", mode, { openid });
    } catch (error) {
      return buildAccessResult("error", mode, {
        stage: "access_check",
        error,
      });
    }
  }

  let identity;
  try {
    identity = await ensureProfileIdentity({
      redirectToSetup: false,
      showError: false,
    });
  } catch (error) {
    return buildAccessResult("error", mode, {
      stage: "access_check",
      error,
    });
  }

  if (identity && identity.error) {
    return buildAccessResult("error", mode, {
      openid: identity.openid,
      profile: identity.profile,
      stage: "access_check",
      error: identity.error,
    });
  }
  if (identity && identity.ready && identity.openid) {
    return buildAccessResult("ready", mode, identity);
  }
  return buildAccessResult("profile_required", mode, identity || {});
}

function showProfileSetupPrompt(copy) {
  return new Promise((resolve, reject) => {
    if (!wx.showModal) {
      reject(new Error("当前环境不支持资料完善提示"));
      return;
    }
    wx.showModal({
      title: copy.title,
      content: copy.content,
      confirmText: copy.confirmText,
      cancelText: copy.cancelText,
      success: resolve,
      fail: reject,
    });
  });
}

function navigateToProfileSetup(source) {
  return new Promise((resolve, reject) => {
    if (!wx.navigateTo) {
      reject(new Error("当前环境不支持页面跳转"));
      return;
    }
    wx.navigateTo({
      url: `${PROFILE_SETUP_URL}&source=${encodeURIComponent(source)}`,
      success: resolve,
      fail: reject,
    });
  });
}

function clearPendingLibraryAction(source) {
  if (!pendingLibraryAction) {
    if (!source) navigationInProgress = false;
    return false;
  }
  if (source && pendingLibraryAction.source !== source) return false;
  pendingLibraryAction = null;
  navigationInProgress = false;
  return true;
}

async function resumePendingLibraryAction(source) {
  if (!pendingLibraryAction || pendingLibraryAction.source !== source) return false;
  const startedAt = Date.now();
  const action = pendingLibraryAction.resume;
  const kind = pendingLibraryAction.kind;
  clearPendingLibraryAction(source);
  if (typeof action !== "function") {
    reportLibraryEvent("pending_action_resume_success", {
      kind,
      source,
      result: "success",
      durationMs: Date.now() - startedAt,
    });
    return { resumed: true, success: true };
  }

  try {
    const actionResult = await action();
    if (actionResult === false) {
      reportLibraryEvent("pending_action_resume_fail", {
        kind,
        source,
        result: "fail",
        durationMs: Date.now() - startedAt,
      });
      return { resumed: true, success: false };
    }
    reportLibraryEvent("pending_action_resume_success", {
      kind,
      source,
      result: "success",
      durationMs: Date.now() - startedAt,
    });
    return { resumed: true, success: true };
  } catch (error) {
    console.error("恢复完善资料前的操作失败", error);
    reportLibraryEvent("pending_action_resume_fail", {
      kind,
      source,
      result: "fail",
      durationMs: Date.now() - startedAt,
    });
    return { resumed: true, success: false };
  }
}

async function performLibraryAccessRequest(options) {
  const startedAt = Date.now();
  const { kind, source, resume } = options;
  const access = await checkLibraryAccess(kind);
  if (access.status !== "profile_required") return access;
  reportLibraryEvent("library_gate_view", {
    kind,
    source,
    result: "profile_required",
    durationMs: Date.now() - startedAt,
  });

  if (navigationInProgress || pendingLibraryAction) {
    const samePendingAction = pendingLibraryAction
      && pendingLibraryAction.kind === kind
      && pendingLibraryAction.source === source;
    return buildAccessResult(samePendingAction ? "redirected" : "cancelled", access.mode, {
      openid: access.openid,
      profile: access.profile,
      stage: "pending_action",
    });
  }

  const copy = getProfileSetupCopy(source);
  let promptResult;
  try {
    promptResult = await showProfileSetupPrompt(copy);
  } catch (error) {
    return buildAccessResult("error", access.mode, {
      openid: access.openid,
      profile: access.profile,
      stage: "prompt",
      error,
    });
  }

  if (!promptResult || promptResult.confirm !== true) {
    reportLibraryEvent("library_gate_cancel", {
      kind,
      source,
      result: "cancel",
      durationMs: Date.now() - startedAt,
    });
    return buildAccessResult("cancelled", access.mode, {
      openid: access.openid,
      profile: access.profile,
    });
  }

  reportLibraryEvent("library_gate_confirm", {
    kind,
    source,
    result: "confirm",
    durationMs: Date.now() - startedAt,
  });
  pendingLibraryAction = {
    kind,
    source,
    token: createPendingToken(),
    resume: typeof resume === "function" ? resume : null,
  };
  navigationInProgress = true;
  try {
    await navigateToProfileSetup(source);
    return buildAccessResult("redirected", access.mode, {
      openid: access.openid,
      profile: access.profile,
    });
  } catch (error) {
    clearPendingLibraryAction(source);
    return buildAccessResult("error", access.mode, {
      openid: access.openid,
      profile: access.profile,
      stage: "navigation",
      error,
    });
  }
}

function requestLibraryAccess(options = {}) {
  const { kind, source } = options;
  validateRequest(kind, source);
  const requestKey = `${kind}:${source}`;
  if (requestInFlight) {
    if (requestInFlight.key === requestKey) return requestInFlight.promise;
    const mode = getLibraryAccessMode(kind);
    return Promise.resolve(buildAccessResult("cancelled", mode, {
      stage: "busy",
    }));
  }

  const promise = performLibraryAccessRequest(options).finally(() => {
    if (requestInFlight && requestInFlight.promise === promise) {
      requestInFlight = null;
    }
  });
  requestInFlight = { key: requestKey, promise };
  return promise;
}

module.exports = {
  checkLibraryAccess,
  clearPendingLibraryAction,
  getProfileSetupCopy,
  reportLibraryEvent,
  requestLibraryAccess,
  resumePendingLibraryAction,
};
