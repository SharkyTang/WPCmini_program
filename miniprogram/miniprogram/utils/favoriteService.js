const { fetchCaseById } = require("./cloudData");
const {
  buildFavoriteRecord,
  isFavoriteLimitReached,
  mergeFavoritesWithCases,
} = require("./favoriteData");
const { ensureWxIdentity, getCachedOpenId } = require("./userService");

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

function buildFavoriteWhere(caseItem) {
  const db = getDb();
  const _ = db.command;
  const record = buildFavoriteRecord(caseItem);
  const conditions = [];

  if (record.caseDocId) {
    conditions.push({ caseDocId: record.caseDocId });
  }
  if (record.caseId && record.caseId !== record.caseDocId) {
    conditions.push({ caseId: record.caseId });
  }

  if (!conditions.length) {
    return { caseDocId: "__missing_case__" };
  }
  if (conditions.length === 1) {
    return conditions[0];
  }
  return _.or(conditions);
}

async function ensureIdentityForRead(options = {}) {
  if (getCachedOpenId()) return true;
  if (!options.silentIdentity) return false;

  try {
    const openid = await ensureWxIdentity({ silent: true });
    return Boolean(openid);
  } catch (error) {
    console.warn("静默读取微信身份失败", error);
    return false;
  }
}

async function fetchFavoriteForCase(caseItem, options = {}) {
  const hasIdentity = await ensureIdentityForRead(options);
  if (!hasIdentity) return null;

  const response = await getFavoritesCollection()
    .where(buildFavoriteWhere(caseItem))
    .limit(1)
    .get();
  return (response.data || [])[0] || null;
}

async function addFavorite(caseItem) {
  const openid = await ensureWxIdentity();
  if (!openid) return null;

  const existing = await fetchFavoriteForCase(caseItem);
  if (existing) return existing;

  const countResponse = await getFavoritesCollection().count();
  if (isFavoriteLimitReached(countResponse.total, FAVORITE_LIMIT)) {
    return {
      limitReached: true,
    };
  }

  const db = getDb();
  const response = await getFavoritesCollection().add({
    data: {
      ...buildFavoriteRecord(caseItem),
      createdAt: db.serverDate(),
    },
  });

  return {
    _id: response._id,
    ...buildFavoriteRecord(caseItem),
  };
}

async function removeFavorite(favoriteId) {
  if (!favoriteId) return false;
  await getFavoritesCollection().doc(favoriteId).remove();
  return true;
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

async function fetchFavoriteCases() {
  const response = await getFavoritesCollection()
    .orderBy("createdAt", "desc")
    .limit(FAVORITE_LIMIT)
    .get();
  const favorites = response.data || [];
  const cases = await Promise.all(
    favorites.map(async (favorite) => {
      try {
        return await fetchCaseById(favorite.caseDocId || favorite.caseId);
      } catch (error) {
        console.warn("收藏案例读取失败", favorite, error);
        return null;
      }
    })
  );

  return mergeFavoritesWithCases(favorites, cases.filter(Boolean));
}

module.exports = {
  FAVORITE_COLLECTION,
  FAVORITE_LIMIT,
  fetchFavoriteForCase,
  addFavorite,
  removeFavorite,
  toggleFavorite,
  fetchFavoriteCases,
};
