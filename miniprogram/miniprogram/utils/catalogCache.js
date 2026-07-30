const CACHE_SCHEMA_VERSION = 2;
const CACHE_TTL_MS = 20 * 60 * 1000;
const HOME_CACHE_KEY = "wineHomeFeedV3";
const CATALOG_CACHE_KEY = "wineCatalogSnapshotV3";

function normalizeCacheEntry(value) {
  if (!value || typeof value !== "object") return null;
  if (value.schemaVersion !== CACHE_SCHEMA_VERSION) return null;
  if (!value.data || typeof value.data !== "object") return null;
  const cachedAt = Number(value.cachedAt);
  const revision = Number(value.revision);
  if (!Number.isFinite(cachedAt) || !Number.isFinite(revision)) return null;
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    cachedAt,
    revision,
    data: value.data,
    fresh: Date.now() - cachedAt < CACHE_TTL_MS,
  };
}

function readCache(key) {
  if (!wx.getStorageSync) return null;
  try {
    return normalizeCacheEntry(wx.getStorageSync(key));
  } catch (error) {
    console.warn("案例缓存读取失败", { key, error });
    return null;
  }
}

function writeCache(key, revision, data) {
  if (!wx.setStorageSync || !data) return;
  try {
    wx.setStorageSync(key, {
      schemaVersion: CACHE_SCHEMA_VERSION,
      cachedAt: Date.now(),
      revision: Number(revision) || 1,
      data,
    });
  } catch (error) {
    console.warn("案例缓存写入失败", { key, error });
  }
}

function clearCache(key) {
  if (!wx.removeStorageSync) return;
  try {
    wx.removeStorageSync(key);
  } catch (error) {
    console.warn("案例缓存清理失败", { key, error });
  }
}

module.exports = {
  CACHE_SCHEMA_VERSION,
  CACHE_TTL_MS,
  CATALOG_CACHE_KEY,
  HOME_CACHE_KEY,
  clearCache,
  normalizeCacheEntry,
  readCache,
  writeCache,
};
