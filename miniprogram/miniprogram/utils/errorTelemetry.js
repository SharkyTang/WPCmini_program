const TELEMETRY_EVENT_NAME = "client_fault";
const PERFORMANCE_EVENT_NAMES = ["client_boot_result", "page_ready_result"];
const PERFORMANCE_DURATION_BUCKETS = new Set([
  "under_500ms",
  "500_999ms",
  "1000_1999ms",
  "2000_4999ms",
  "5000ms_plus",
  "pending",
  "not_applicable",
  "unknown",
]);
const MAX_FATAL_EVENTS_PER_SESSION = 10;
const MAX_NON_FATAL_EVENTS_PER_SESSION = 5;
const MAX_EVENTS_PER_SESSION = MAX_FATAL_EVENTS_PER_SESSION;

const FATAL_FAULT_TYPES = new Set([
  "app_error",
  "cloud_init_error",
  "unhandled_rejection",
  "page_not_found",
  "page_not_found_redirect_error",
]);

const reportedFingerprints = new Set();
const reportedPerformanceKeys = new Set();
let reportedFatalEventCount = 0;
let reportedNonFatalEventCount = 0;
let reportedPerformanceCount = 0;
let cachedRuntimeContext = null;

function sanitizeEnum(value, fallback = "unknown", maxLength = 48) {
  const text = typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
  if (!text) return fallback;
  const sanitized = text.replace(/[^a-zA-Z0-9_./-]/g, "_");
  return sanitized.slice(0, maxLength) || fallback;
}

function sanitizeRoute(value) {
  const path = typeof value === "string" ? value.split(/[?#]/, 1)[0] : "";
  return sanitizeEnum(path.replace(/^\/+/, ""), "unknown", 80);
}

function sanitizeErrorCode(value) {
  const text = typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
  if (!text || text.length > 40) return "UNKNOWN_ERROR";
  if (/^-?\d{1,12}$/.test(text) || /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(text)) {
    return text;
  }
  return "UNKNOWN_ERROR";
}

function normalizeError(error) {
  if (error && typeof error === "object") {
    return {
      name: typeof error.name === "string" ? error.name : "Error",
      code: error.code || error.errCode || "UNKNOWN_ERROR",
      message:
        typeof error.message === "string"
          ? error.message
          : typeof error.errMsg === "string"
            ? error.errMsg
            : "",
      stack: typeof error.stack === "string" ? error.stack : "",
    };
  }
  return {
    name: "Error",
    code: "UNKNOWN_ERROR",
    message: typeof error === "string" ? error : String(error || ""),
    stack: "",
  };
}

function hashText(value) {
  const text = String(value || "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `e${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function getErrorFingerprint(error) {
  const normalized = normalizeError(error);
  const firstFrame = normalized.stack.split("\n").slice(0, 2).join("|");
  return hashText(
    `${normalized.name}|${normalized.code}|${normalized.message}|${firstFrame}`
  );
}

function getCurrentRoute() {
  try {
    if (typeof getCurrentPages !== "function") return "unknown";
    const pages = getCurrentPages();
    const currentPage = pages && pages.length ? pages[pages.length - 1] : null;
    return sanitizeRoute(currentPage && (currentPage.route || currentPage.__route__));
  } catch (error) {
    return "unknown";
  }
}

function getDeviceTier(benchmarkLevel) {
  const level = Number(benchmarkLevel);
  if (!Number.isFinite(level) || level < 0) return "unknown";
  if (level <= 10) return "low";
  if (level <= 30) return "mid";
  return "high";
}

function readRuntimeContext() {
  if (cachedRuntimeContext) return cachedRuntimeContext;
  let device = {};
  let appBase = {};
  let account = {};
  let launchOptions = {};

  try {
    if (typeof wx !== "undefined" && wx.getDeviceInfo) {
      device = wx.getDeviceInfo() || {};
    } else if (typeof wx !== "undefined" && wx.getSystemInfoSync) {
      device = wx.getSystemInfoSync() || {};
    }
  } catch (error) {
    device = {};
  }
  try {
    if (typeof wx !== "undefined" && wx.getAppBaseInfo) {
      appBase = wx.getAppBaseInfo() || {};
    } else if (typeof wx !== "undefined" && wx.getSystemInfoSync) {
      appBase = wx.getSystemInfoSync() || {};
    }
  } catch (error) {
    appBase = {};
  }
  try {
    if (typeof wx !== "undefined" && wx.getAccountInfoSync) {
      account = wx.getAccountInfoSync() || {};
    }
  } catch (error) {
    account = {};
  }
  try {
    if (typeof wx !== "undefined" && wx.getLaunchOptionsSync) {
      launchOptions = wx.getLaunchOptionsSync() || {};
    }
  } catch (error) {
    launchOptions = {};
  }

  const miniProgram = account && account.miniProgram ? account.miniProgram : {};
  cachedRuntimeContext = {
    platform: sanitizeEnum(device.platform, "unknown", 16),
    sdkVersion: sanitizeEnum(appBase.SDKVersion, "unknown", 24),
    appVersion: sanitizeEnum(miniProgram.version, "unknown", 24),
    envVersion: sanitizeEnum(miniProgram.envVersion, "unknown", 16),
    deviceTier: getDeviceTier(device.benchmarkLevel),
    scene: sanitizeEnum(launchOptions.scene, "unknown", 12),
  };
  return cachedRuntimeContext;
}

function reportClientFault(input = {}) {
  if (typeof wx === "undefined" || typeof wx.reportEvent !== "function") {
    return false;
  }

  const normalizedError = normalizeError(input.error);
  const type = sanitizeEnum(input.type, "runtime_error", 32);
  const isFatal = input.fatal === true || FATAL_FAULT_TYPES.has(type);
  if (
    (isFatal && reportedFatalEventCount >= MAX_FATAL_EVENTS_PER_SESSION) ||
    (!isFatal && reportedNonFatalEventCount >= MAX_NON_FATAL_EVENTS_PER_SESSION)
  ) {
    return false;
  }
  const route = sanitizeRoute(input.route || getCurrentRoute());
  const stage = sanitizeEnum(input.stage, "unknown", 40);
  const errorCode = sanitizeErrorCode(input.code || normalizedError.code);
  const errorFingerprint = getErrorFingerprint(input.error || {
    code: input.code || type,
    message: `${stage}|${input.action || ""}`,
  });
  const dedupeKey = isFatal
    ? `fatal|${errorFingerprint}`
    : `non_fatal|${sanitizeEnum(input.action, "none", 40)}|${errorCode}`;
  if (reportedFingerprints.has(dedupeKey)) return false;

  reportedFingerprints.add(dedupeKey);
  if (isFatal) {
    reportedFatalEventCount += 1;
  } else {
    reportedNonFatalEventCount += 1;
  }
  const runtime = readRuntimeContext();
  const payload = {
    type,
    route,
    stage,
    error_code: errorCode,
    error_fingerprint: errorFingerprint,
    action: sanitizeEnum(input.action, "none", 40),
    request_kind: sanitizeEnum(input.requestKind, "unknown", 20),
    cache_state: sanitizeEnum(input.cacheState, "unknown", 20),
    fallback_used: input.fallbackUsed ? 1 : 0,
    disposed: input.disposed ? 1 : 0,
    platform: runtime.platform,
    sdk_version: runtime.sdkVersion,
    app_version: runtime.appVersion,
    env_version: sanitizeEnum(input.envVersion || runtime.envVersion, "unknown", 16),
    device_tier: runtime.deviceTier,
    scene: runtime.scene,
  };

  try {
    wx.reportEvent(TELEMETRY_EVENT_NAME, payload);
    return true;
  } catch (error) {
    return false;
  }
}

function normalizeDuration(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration < 0) return 0;
  return Math.min(Math.round(duration), 10 * 60 * 1000);
}

function normalizeDurationBucket(value) {
  const bucket = sanitizeEnum(value, "unknown", 24);
  return PERFORMANCE_DURATION_BUCKETS.has(bucket) ? bucket : "unknown";
}

function reportPerformanceEvent(name, input = {}) {
  if (
    typeof wx === "undefined" ||
    typeof wx.reportEvent !== "function" ||
    reportedPerformanceCount >= MAX_EVENTS_PER_SESSION
  ) {
    return false;
  }

  const eventType = sanitizeEnum(name, "performance", 40);
  if (!PERFORMANCE_EVENT_NAMES.includes(eventType)) return false;
  const route = sanitizeRoute(input.route || getCurrentRoute());
  const stage = sanitizeEnum(input.stage, "complete", 40);
  const durationMs = normalizeDuration(input.durationMs);
  const dedupeKey = [
    eventType,
    route,
    stage,
    sanitizeEnum(input.requestKind, "unknown", 20),
    sanitizeEnum(input.cacheState, "unknown", 20),
    input.success === false ? "0" : "1",
  ].join("|");
  if (reportedPerformanceKeys.has(dedupeKey)) return false;

  reportedPerformanceKeys.add(dedupeKey);
  reportedPerformanceCount += 1;
  const runtime = readRuntimeContext();
  const payload = {
    route,
    stage,
    duration_ms: durationMs,
    success: input.success === false ? 0 : 1,
    action: sanitizeEnum(input.action, "none", 40),
    request_kind: sanitizeEnum(input.requestKind, "unknown", 20),
    cache_state: sanitizeEnum(input.cacheState, "unknown", 20),
    fallback_used: input.fallbackUsed ? 1 : 0,
    disposed: input.disposed ? 1 : 0,
    platform: runtime.platform,
    sdk_version: runtime.sdkVersion,
    app_version: runtime.appVersion,
    env_version: sanitizeEnum(input.envVersion || runtime.envVersion, "unknown", 16),
    device_tier: runtime.deviceTier,
    scene: runtime.scene,
  };
  if (eventType === "client_boot_result") {
    payload.duration_bucket = normalizeDurationBucket(
      input.duration_bucket || input.durationBucket
    );
    payload.shell_bucket = normalizeDurationBucket(
      input.shell_bucket || input.shellBucket
    );
    payload.on_ready_bucket = normalizeDurationBucket(
      input.on_ready_bucket || input.onReadyBucket
    );
    payload.hero_bucket = normalizeDurationBucket(
      input.hero_bucket || input.heroBucket
    );
    payload.data_bucket = normalizeDurationBucket(
      input.data_bucket || input.dataBucket
    );
  }

  try {
    wx.reportEvent(eventType, payload);
    return true;
  } catch (error) {
    return false;
  }
}

function resetTelemetryForTests() {
  reportedFingerprints.clear();
  reportedPerformanceKeys.clear();
  reportedFatalEventCount = 0;
  reportedNonFatalEventCount = 0;
  reportedPerformanceCount = 0;
  cachedRuntimeContext = null;
}

module.exports = {
  MAX_FATAL_EVENTS_PER_SESSION,
  MAX_EVENTS_PER_SESSION,
  MAX_NON_FATAL_EVENTS_PER_SESSION,
  PERFORMANCE_EVENT_NAMES,
  TELEMETRY_EVENT_NAME,
  getCurrentRoute,
  getErrorFingerprint,
  normalizeDurationBucket,
  reportClientFault,
  reportPerformanceEvent,
  resetTelemetryForTests,
  sanitizeErrorCode,
  sanitizeRoute,
};
