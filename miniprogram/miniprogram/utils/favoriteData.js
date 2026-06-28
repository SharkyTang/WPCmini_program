function getCaseDocumentId(caseItem) {
  return caseItem && (caseItem.id || caseItem._id || "");
}

function getStableCaseId(caseItem) {
  if (!caseItem) return "";
  return caseItem.caseId || getCaseDocumentId(caseItem);
}

function buildFavoriteRecord(caseItem) {
  const caseDocId = getCaseDocumentId(caseItem);
  const caseId = getStableCaseId(caseItem);

  return {
    caseDocId,
    caseId,
  };
}

function getFavoriteCaseLookupKeys(favorites) {
  const keys = [];
  const seen = {};

  (favorites || []).forEach((favorite) => {
    [favorite.caseDocId, favorite.caseId].forEach((key) => {
      if (!key || seen[key]) return;
      seen[key] = true;
      keys.push(key);
    });
  });

  return keys;
}

function buildCaseMap(cases) {
  return (cases || []).reduce((map, caseItem) => {
    if (!caseItem || caseItem.isVisible === false) return map;
    const caseDocId = getCaseDocumentId(caseItem);
    const caseId = getStableCaseId(caseItem);
    if (caseDocId) map[caseDocId] = caseItem;
    if (caseId) map[caseId] = caseItem;
    return map;
  }, {});
}

function mergeFavoritesWithCases(favorites, cases) {
  const caseMap = buildCaseMap(cases);

  return (favorites || []).reduce((items, favorite) => {
    const caseItem = caseMap[favorite.caseDocId] || caseMap[favorite.caseId];
    if (!caseItem) return items;
    items.push({
      favoriteId: favorite._id || favorite.id,
      caseItem,
    });
    return items;
  }, []);
}

function isFavoriteLimitReached(count, limit) {
  return (Number(count) || 0) >= (Number(limit) || 0);
}

function normalizeSelectedFavoriteIds(ids) {
  const selectedIds = [];
  const seen = {};

  (ids || []).forEach((id) => {
    if (!id || seen[id]) return;
    seen[id] = true;
    selectedIds.push(id);
  });

  return selectedIds;
}

module.exports = {
  buildFavoriteRecord,
  getFavoriteCaseLookupKeys,
  isFavoriteLimitReached,
  mergeFavoritesWithCases,
  normalizeSelectedFavoriteIds,
};
