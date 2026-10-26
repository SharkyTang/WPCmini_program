const DEFAULT_DELAY_MS = 120;
const DEFAULT_MIN_VISIBLE_MS = 300;
const DEFAULT_MAX_VISIBLE_MS = 3000;

function toDuration(value, fallback) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration >= 0 ? duration : fallback;
}

function createNativePageLoadingController(options = {}) {
  const wxApi = options.wxApi;
  const getWxApi = typeof options.getWxApi === "function"
    ? options.getWxApi
    : () => wxApi;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const setTimer = typeof options.setTimeoutFn === "function"
    ? options.setTimeoutFn
    : setTimeout;
  const clearTimer = typeof options.clearTimeoutFn === "function"
    ? options.clearTimeoutFn
    : clearTimeout;

  let sequence = 0;
  let active = null;

  function clearTimerSafely(timerId) {
    if (timerId === null || timerId === undefined) return;
    try {
      clearTimer(timerId);
    } catch (error) {
      // Native loading must never interfere with page behavior.
    }
  }

  function clearRecordTimers(record) {
    clearTimerSafely(record.delayTimer);
    clearTimerSafely(record.finishTimer);
    clearTimerSafely(record.maxTimer);
    record.delayTimer = null;
    record.finishTimer = null;
    record.maxTimer = null;
  }

  function hideNativeLoading() {
    try {
      const api = getWxApi();
      if (api && typeof api.hideLoading === "function") {
        api.hideLoading();
      }
    } catch (error) {
      // Loading feedback is best-effort and must fail silently.
    }
  }

  function showNativeLoading(record) {
    if (active !== record || record.ended || record.finishRequested) return;
    record.delayTimer = null;
    record.visible = true;
    record.shownAt = now();
    try {
      const api = getWxApi();
      if (api && typeof api.showLoading === "function") {
        api.showLoading({
          title: record.title,
          mask: record.mask,
        });
      }
    } catch (error) {
      // Loading feedback is best-effort and must fail silently.
    }
    try {
      record.maxTimer = setTimer(() => {
        if (active !== record || record.ended) return;
        endRecord(record, true);
      }, record.maxVisibleMs);
    } catch (error) {
      // A timer failure must not make page loading fail.
    }
  }

  function endRecord(record, hide) {
    if (active !== record || record.ended) return false;
    record.ended = true;
    clearRecordTimers(record);
    active = null;
    if (hide && record.visible) hideNativeLoading();
    return true;
  }

  function supersedeActiveRecord() {
    if (!active) return;
    endRecord(active, true);
  }

  function beginPageLoading(beginOptions = {}) {
    beginOptions = beginOptions && typeof beginOptions === "object"
      ? beginOptions
      : {};
    supersedeActiveRecord();

    const token = Object.freeze({ id: ++sequence });
    const record = {
      token,
      title: typeof beginOptions.title === "string" && beginOptions.title
        ? beginOptions.title
        : "加载中",
      mask: beginOptions.mask === true,
      delayMs: toDuration(beginOptions.delayMs, DEFAULT_DELAY_MS),
      minVisibleMs: toDuration(
        beginOptions.minVisibleMs,
        DEFAULT_MIN_VISIBLE_MS
      ),
      maxVisibleMs: toDuration(
        beginOptions.maxVisibleMs,
        DEFAULT_MAX_VISIBLE_MS
      ),
      delayTimer: null,
      finishTimer: null,
      maxTimer: null,
      shownAt: null,
      visible: false,
      finishRequested: false,
      ended: false,
    };
    active = record;

    try {
      record.delayTimer = setTimer(() => showNativeLoading(record), record.delayMs);
    } catch (error) {
      showNativeLoading(record);
    }
    return token;
  }

  function finishPageLoading(token) {
    const record = active;
    if (!record || record.token !== token || record.ended) return false;
    if (record.finishRequested) return true;
    record.finishRequested = true;

    if (!record.visible) {
      return endRecord(record, false);
    }

    const visibleFor = Math.max(0, now() - record.shownAt);
    const remaining = Math.max(0, record.minVisibleMs - visibleFor);
    if (!remaining) return endRecord(record, true);

    try {
      record.finishTimer = setTimer(() => {
        if (active !== record || record.ended) return;
        endRecord(record, true);
      }, remaining);
      return true;
    } catch (error) {
      return endRecord(record, true);
    }
  }

  function cancelPageLoading(token) {
    const record = active;
    if (!record || record.token !== token || record.ended) return false;
    return endRecord(record, true);
  }

  return {
    beginPageLoading,
    finishPageLoading,
    cancelPageLoading,
  };
}

const defaultController = createNativePageLoadingController({
  getWxApi() {
    return typeof wx !== "undefined" ? wx : null;
  },
});

module.exports = {
  beginPageLoading: defaultController.beginPageLoading,
  finishPageLoading: defaultController.finishPageLoading,
  cancelPageLoading: defaultController.cancelPageLoading,
  createNativePageLoadingController,
};
