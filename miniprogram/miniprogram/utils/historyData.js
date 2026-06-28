function getCaseDocumentId(caseItem) {
  return caseItem && (caseItem.id || caseItem._id || "");
}

function getStableCaseId(caseItem) {
  if (!caseItem) return "";
  return caseItem.caseId || getCaseDocumentId(caseItem);
}

function buildHistoryRecord(caseItem) {
  const caseDocId = getCaseDocumentId(caseItem);
  const caseId = getStableCaseId(caseItem);

  return {
    caseDocId,
    caseId,
  };
}

function getHistoryCaseLookupKeys(historyRecords) {
  const keys = [];
  const seen = {};

  (historyRecords || []).forEach((record) => {
    [record.caseDocId, record.caseId].forEach((key) => {
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

function mergeHistoryWithCases(historyRecords, cases) {
  const caseMap = buildCaseMap(cases);

  return (historyRecords || []).reduce((items, record) => {
    const caseItem = caseMap[record.caseDocId] || caseMap[record.caseId];
    if (!caseItem) return items;
    items.push({
      historyId: record._id || record.id,
      viewCount: record.viewCount || 0,
      caseItem,
    });
    return items;
  }, []);
}

function normalizeSelectedIds(ids) {
  const seen = {};
  const normalized = [];

  (ids || []).forEach((id) => {
    if (!id || seen[id]) return;
    seen[id] = true;
    normalized.push(id);
  });

  return normalized;
}

function getOverflowHistoryIds(historyRecords, limit) {
  const safeLimit = Math.max(Number(limit) || 0, 0);
  return (historyRecords || [])
    .slice(safeLimit)
    .map((record) => record && (record._id || record.id))
    .filter(Boolean);
}

module.exports = {
  buildHistoryRecord,
  getOverflowHistoryIds,
  getHistoryCaseLookupKeys,
  mergeHistoryWithCases,
  normalizeSelectedIds,
};
