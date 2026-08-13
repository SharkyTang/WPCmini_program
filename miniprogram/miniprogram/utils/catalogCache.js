const CACHE_SCHEMA_VERSION = 2;
const CACHE_TTL_MS = 20 * 60 * 1000;
const HOME_CACHE_KEY = "wineHomeFeedV3";
const CATALOG_CACHE_KEY = "wineCatalogSnapshotV3";
const cacheWriteQueues = new Map();

let reportClientFault = () => false;
try {
  ({ reportClientFault } = require("./errorTelemetry"));
} catch (error) {
  reportClientFault = () => false;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRecordList(value) {
  return Array.isArray(value) && value.every(isRecord);
}

function normalizeRevision(value) {
  const revision = Number(value);
  return Number.isFinite(revision) && revision >= 0 ? revision : 0;
}

function validateHomeData(data) {
  return (
    isRecord(data) &&
    isRecordList(data.banners) &&
    isRecordList(data.popularCases) &&
    isRecordList(data.latestCases)
  );
}

function validateCatalogData(data) {
  return isRecord(data) && isRecordList(data.items);
}

function getDataValidator(key, data) {
  if (key === HOME_CACHE_KEY) return validateHomeData;
  if (key === CATALOG_CACHE_KEY) return validateCatalogData;
  if (isRecord(data) && Object.prototype.hasOwnProperty.call(data, "items")) {
    return validateCatalogData;
  }
  if (
    isRecord(data) &&
    ["banners", "popularCases", "latestCases"].some((field) =>
      Object.prototype.hasOwnProperty.call(data, field)
    )
  ) {
    return validateHomeData;
  }
  return () => false;
}

function inspectCacheEntry(value, key) {
  if (!isRecord(value)) return { entry: null, reason: "invalid_envelope" };
  if (value.schemaVersion !== CACHE_SCHEMA_VERSION) {
    return { entry: null, reason: "schema_mismatch" };
  }
  if (!isRecord(value.data)) return { entry: null, reason: "invalid_data" };
  const cachedAt = Number(value.cachedAt);
  const revision = Number(value.revision);
  if (!Number.isFinite(cachedAt) || cachedAt <= 0) {
    return { entry: null, reason: "invalid_timestamp" };
  }
  if (!Number.isFinite(revision) || revision < 0) {
    return { entry: null, reason: "invalid_revision" };
  }
  if (!getDataValidator(key, value.data)(value.data)) {
    return { entry: null, reason: "invalid_data_shape" };
  }
  return {
    entry: {
      schemaVersion: CACHE_SCHEMA_VERSION,
      cachedAt,
      revision,
      data: value.data,
      fresh: Date.now() - cachedAt < CACHE_TTL_MS,
    },
    reason: "",
  };
}

function normalizeCacheEntry(value, key) {
  return inspectCacheEntry(value, key).entry;
}

function reportCacheFault(stage, key, error, code) {
  reportClientFault({
    type: "cache_error",
    stage,
    code,
    error,
    action: key === HOME_CACHE_KEY ? "home_cache" : "catalog_cache",
    cacheState: "invalid",
  });
}

function notifyInvalidCache(options, reason) {
  if (!options || typeof options.onInvalid !== "function") return;
  try {
    options.onInvalid(reason);
  } catch (error) {
    // Cache diagnostics must never interrupt page startup.
  }
}

function readCache(key, options = {}) {
  if (typeof wx === "undefined" || typeof wx.getStorageSync !== "function") {
    return null;
  }
  try {
    const storedValue = wx.getStorageSync(key);
    if (storedValue === undefined || storedValue === null || storedValue === "") {
      return null;
    }
    const result = inspectCacheEntry(storedValue, key);
    if (result.entry) return result.entry;
    clearCache(key);
    notifyInvalidCache(options, result.reason);
    reportCacheFault("cache_validate", key, null, result.reason);
    return null;
  } catch (error) {
    console.warn("案例缓存读取失败", { key, error });
    notifyInvalidCache(options, "storage_read_failed");
    reportCacheFault("cache_read", key, error, "storage_read_failed");
    return null;
  }
}

function writeCache(key, revision, data) {
  const validator = getDataValidator(key, data);
  if (!validator(data)) {
    clearCache(key);
    reportCacheFault("cache_write_validate", key, null, "invalid_data_shape");
    return false;
  }
  if (typeof wx === "undefined" || typeof wx.setStorageSync !== "function") {
    return false;
  }
  try {
    wx.setStorageSync(key, {
      schemaVersion: CACHE_SCHEMA_VERSION,
      cachedAt: Date.now(),
      revision: normalizeRevision(revision),
      data,
    });
    return true;
  } catch (error) {
    console.warn("案例缓存写入失败", { key, error });
    reportCacheFault("cache_write", key, error, "storage_write_failed");
    return false;
  }
}

function enqueueCacheWrite(key, operation) {
  const previous = cacheWriteQueues.get(key) || Promise.resolve();
  let task;
  task = previous
    .catch(() => false)
    .then(operation)
    .catch((error) => {
      reportCacheFault("cache_write", key, error, "storage_write_failed");
      return false;
    })
    .finally(() => {
      if (cacheWriteQueues.get(key) === task) cacheWriteQueues.delete(key);
    });
  cacheWriteQueues.set(key, task);
  return task;
}

function persistCacheEntryAsync(key, revision, data) {
  if (typeof wx === "undefined" || typeof wx.setStorage !== "function") {
    return writeCache(key, revision, data);
  }
  const entry = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    cachedAt: Date.now(),
    revision: normalizeRevision(revision),
    data,
  };
  return new Promise((resolve) => {
    try {
      wx.setStorage({
        key,
        data: entry,
        success() {
          resolve(true);
        },
        fail(error) {
          reportCacheFault("cache_write", key, error, "storage_write_failed");
          resolve(false);
        },
      });
    } catch (error) {
      reportCacheFault("cache_write", key, error, "storage_write_failed");
      resolve(false);
    }
  });
}

function writeCacheAsync(key, revision, data) {
  return enqueueCacheWrite(key, () => {
    const validator = getDataValidator(key, data);
    if (!validator(data)) {
      clearCache(key);
      reportCacheFault("cache_write_validate", key, null, "invalid_data_shape");
      return false;
    }
    return persistCacheEntryAsync(key, revision, data);
  });
}

function clearCache(key) {
  if (typeof wx === "undefined" || typeof wx.removeStorageSync !== "function") {
    return false;
  }
  try {
    wx.removeStorageSync(key);
    return true;
  } catch (error) {
    console.warn("案例缓存清理失败", { key, error });
    reportCacheFault("cache_clear", key, error, "storage_remove_failed");
    return false;
  }
}

function touchCache(key, revision) {
  const entry = readCache(key);
  if (!entry) return false;
  return writeCache(key, normalizeRevision(revision), entry.data);
}

function touchCacheAsync(key, revision) {
  return enqueueCacheWrite(key, () => {
    const entry = readCache(key);
    if (!entry) return false;
    return persistCacheEntryAsync(
      key,
      normalizeRevision(revision),
      entry.data
    );
  });
}

module.exports = {
  CACHE_SCHEMA_VERSION,
  CACHE_TTL_MS,
  CATALOG_CACHE_KEY,
  HOME_CACHE_KEY,
  clearCache,
  inspectCacheEntry,
  normalizeCacheEntry,
  normalizeRevision,
  readCache,
  touchCache,
  touchCacheAsync,
  validateCatalogData,
  validateHomeData,
  writeCache,
  writeCacheAsync,
};
