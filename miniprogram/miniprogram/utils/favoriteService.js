const { fetchCaseById } = require("./cloudData");
const {
  buildFavoriteRecord,
  isFavoriteLimitReached,
  mergeFavoritesWithCases,
  normalizeSelectedFavoriteIds,
} = require("./favoriteData");
const { checkLibraryAccess } = require("./libraryAccessService");
const { fetchUserLibrary } = require("./caseCatalogService");
const {
  callUserLibrary,
  isUserLibraryUnavailableError,
} = require("./userLibraryService");

const FAVORITE_COLLECTION = "favorites";
const FAVORITE_LIMIT = 100;

function getDb() {
  if (!wx.cloud) {
    throw new Error("当前基础库不支持云开发");
  }
  return wx.cloud.database();
}

function getFavoritesCollection() {
  return getDb().collection(FAVORITE_COLLECTION);
}

function buildFavoriteLookupConditions(caseItem, openid) {
  const record = buildFavoriteRecord(caseItem);
  const conditions = [];

  if (record.caseDocId) {
    conditions.push({ _openid: openid, caseDocId: record.caseDocId });
  }
  if (record.caseId && record.caseId !== record.caseDocId) {
    conditions.push({ _openid: openid, caseId: record.caseId });
  }

  if (!conditions.length) {
    return [{ _openid: openid, caseDocId: "__missing_case__" }];
  }
  return conditions;
}

function isCaseNotFoundError(error) {
  return Boolean(error && error.code === "CASE_NOT_FOUND");
}

async function ensureIdentityForRead(options = {}) {
  try {
    const access = await checkLibraryAccess("favorites", options);
    return access.status === "ready" ? access.openid : "";
  } catch (error) {
    console.warn("静默读取微信身份失败", error);
    return "";
  }
}

async function fetchFavoriteForCase(caseItem, options = {}) {
  const openid = await ensureIdentityForRead(options);
  if (!openid) return null;

  const conditions = buildFavoriteLookupConditions(caseItem, openid);
  for (const condition of conditions) {
    const response = await getFavoritesCollection().where(condition).limit(1).get();
    const favorite = (response.data || [])[0];
    if (favorite) return favorite;
  }
  return null;
}

async function addFavoriteLegacy(caseItem, openid) {
  const existing = await fetchFavoriteForCase(caseItem);
  if (existing) return existing;

  const countResponse = await getFavoritesCollection().where({ _openid: openid }).count();
  if (isFavoriteLimitReached(countResponse.total, FAVORITE_LIMIT)) {
    return {
      limitReached: true,
    };
  }

  const db = getDb();
  const response = await getFavoritesCollection().add({
    data: {
      ...buildFavoriteRecord(caseItem),
      openid,
      createdAt: db.serverDate(),
    },
  });

  return {
    _id: response._id,
    ...buildFavoriteRecord(caseItem),
  };
}

async function addFavorite(caseItem) {
  const access = await checkLibraryAccess("favorites");
  const openid = access.status === "ready" ? access.openid : "";
  if (!openid) return null;

  try {
    const result = await callUserLibrary("addFavorite", {
      favorite: buildFavoriteRecord(caseItem),
    });
    if (result.limitReached) return { limitReached: true };
    return result.favorite || null;
  } catch (error) {
    if (!isUserLibraryUnavailableError(error)) throw error;
    console.warn("用户收藏云函数尚未部署，使用兼容写入");
    return addFavoriteLegacy(caseItem, openid);
  }
}

async function removeFavoriteLegacy(favoriteId, openid) {
  const response = await getFavoritesCollection()
    .where({ _id: favoriteId, _openid: openid })
    .limit(1)
    .get();
  const favorite = (response.data || [])[0];
  if (!favorite || !favorite._id) return false;

  await getFavoritesCollection().doc(favorite._id).remove();
  return true;
}

async function removeFavorite(favoriteId) {
  if (!favoriteId) return false;
  const removedCount = await removeFavoriteRecords([favoriteId]);
  return removedCount > 0;
}

async function removeFavoriteRecordsLegacy(favoriteIds, openid) {
  const ids = normalizeSelectedFavoriteIds(favoriteIds);
  if (!ids.length) return 0;

  const results = await Promise.all(
    ids.map((id) => removeFavoriteLegacy(id, openid))
  );
  return results.filter(Boolean).length;
}

async function removeFavoriteRecords(favoriteIds) {
  const ids = normalizeSelectedFavoriteIds(favoriteIds);
  if (!ids.length) return 0;
  const openid = await ensureIdentityForRead({ silentIdentity: true });
  if (!openid) return 0;

  try {
    const result = await callUserLibrary("removeFavorites", { ids });
    return Number(result.removedCount) || 0;
  } catch (error) {
    if (!isUserLibraryUnavailableError(error)) throw error;
    console.warn("用户收藏云函数尚未部署，使用兼容删除");
    return removeFavoriteRecordsLegacy(ids, openid);
  }
}

async function clearFavoritesLegacy(openid) {
  if (!openid) return 0;

  let removedCount = 0;

  while (true) {
    const response = await getFavoritesCollection()
      .where({ _openid: openid })
      .limit(100)
      .get();
    const ids = normalizeSelectedFavoriteIds(
      (response.data || []).map((favorite) => favorite._id || favorite.id)
    );

    if (!ids.length) break;
    removedCount += await removeFavoriteRecordsLegacy(ids, openid);
    if (ids.length < 100) break;
  }

  return removedCount;
}

async function clearFavorites() {
  const openid = await ensureIdentityForRead({ silentIdentity: true });
  if (!openid) return 0;

  try {
    const result = await callUserLibrary("clearFavorites");
    return Number(result.removedCount) || 0;
  } catch (error) {
    if (!isUserLibraryUnavailableError(error)) throw error;
    console.warn("用户收藏云函数尚未部署，使用兼容清空");
    return clearFavoritesLegacy(openid);
  }
}

async function toggleFavorite(caseItem, currentFavorite) {
  if (currentFavorite && currentFavorite._id) {
    await removeFavorite(currentFavorite._id);
    return {
      isFavorited: false,
      favorite: null,
      action: "removed",
    };
  }

  const favorite = await addFavorite(caseItem);
  if (favorite && favorite.limitReached) {
    return {
      isFavorited: false,
      favorite: null,
      action: "limitReached",
    };
  }

  if (!favorite) {
    return {
      isFavorited: false,
      favorite: null,
      action: "cancelled",
    };
  }

  return {
    isFavorited: true,
    favorite,
    action: "added",
  };
}

async function fetchFavoriteCasesLegacy() {
  const openid = await ensureIdentityForRead({ silentIdentity: true });
  if (!openid) return [];

  const response = await getFavoritesCollection()
    .where({ _openid: openid })
    .orderBy("createdAt", "desc")
    .limit(FAVORITE_LIMIT)
    .get();
  const favorites = response.data || [];
  const resolvedFavorites = await Promise.all(
    favorites.map(async (favorite) => {
      try {
        return {
          favorite,
          caseItem: await fetchCaseById(favorite.caseDocId || favorite.caseId),
        };
      } catch (error) {
        if (isCaseNotFoundError(error)) {
          return { favorite, caseItem: null, isStale: true };
        }
        console.warn("收藏案例读取失败", favorite, error);
        return { favorite, caseItem: null };
      }
    })
  );

  const staleIds = resolvedFavorites
    .filter((item) => item.isStale)
    .map((item) => item.favorite._id || item.favorite.id)
    .filter(Boolean);
  if (staleIds.length) {
    try {
      await removeFavoriteRecords(staleIds);
    } catch (error) {
      console.warn("失效收藏清理失败", error);
    }
  }

  return mergeFavoritesWithCases(
    favorites.filter((favorite) => !staleIds.includes(favorite._id || favorite.id)),
    resolvedFavorites.map((item) => item.caseItem).filter(Boolean)
  );
}

async function fetchFavoriteCases() {
  const openid = await ensureIdentityForRead({ silentIdentity: true });
  if (!openid) return [];
  try {
    const items = await fetchUserLibrary("favorites");
    return items.map((item) => ({
      favoriteId: item.recordId,
      caseItem: item.caseItem,
    }));
  } catch (error) {
    console.warn("收藏聚合接口不可用，使用兼容读取", error);
    return fetchFavoriteCasesLegacy();
  }
}

module.exports = {
  FAVORITE_COLLECTION,
  FAVORITE_LIMIT,
  fetchFavoriteForCase,
  addFavorite,
  addFavoriteLegacy,
  removeFavorite,
  removeFavoriteRecords,
  removeFavoriteRecordsLegacy,
  clearFavorites,
  clearFavoritesLegacy,
  toggleFavorite,
  fetchFavoriteCases,
  fetchFavoriteCasesLegacy,
};
