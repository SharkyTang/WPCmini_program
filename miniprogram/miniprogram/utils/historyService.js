const { fetchCaseById } = require("./cloudData");
const {
  buildHistoryRecord,
  getOverflowHistoryIds,
  mergeHistoryWithCases,
  normalizeSelectedIds,
} = require("./historyData");
const { checkLibraryAccess } = require("./libraryAccessService");
const { getCachedOpenId } = require("./userService");
const { fetchUserLibrary } = require("./caseCatalogService");

const HISTORY_COLLECTION = "browse_history";
const HISTORY_LIMIT = 50;

function getDb() {
  if (!wx.cloud) {
    throw new Error("当前基础库不支持云开发");
  }
  return wx.cloud.database();
}

function getHistoryCollection() {
  return getDb().collection(HISTORY_COLLECTION);
}

function buildHistoryLookupConditions(caseItem, openid) {
  const record = buildHistoryRecord(caseItem);
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

async function ensureIdentityForHistory() {
  try {
    const access = await checkLibraryAccess("history");
    return access.status === "ready" ? access.openid : "";
  } catch (error) {
    console.warn("浏览记录身份恢复失败", error);
    return "";
  }
}

async function removeHistoryRecords(historyIds) {
  const ids = normalizeSelectedIds(historyIds);
  if (!ids.length) return 0;

  const openid = await ensureIdentityForHistory();
  if (!openid) return 0;

  const results = await Promise.all(ids.map(async (id) => {
    const response = await getHistoryCollection()
      .where({ _id: id, _openid: openid })
      .limit(1)
      .get();
    const record = (response.data || [])[0];
    if (!record || !record._id) return false;
    await getHistoryCollection().doc(record._id).remove();
    return true;
  }));
  return results.filter(Boolean).length;
}

async function trimHistoryLimit(limit = HISTORY_LIMIT, openid = getCachedOpenId()) {
  if (!openid) return 0;

  let removedCount = 0;

  while (true) {
    const response = await getHistoryCollection()
      .where({ _openid: openid })
      .orderBy("lastViewedAt", "desc")
      .skip(limit)
      .limit(100)
      .get();
    const overflowIds = getOverflowHistoryIds(response.data || [], 0);
    if (!overflowIds.length) break;

    removedCount += await removeHistoryRecords(overflowIds);
    if (overflowIds.length < 100) break;
  }

  return removedCount;
}

function trimHistoryInBackground(openid) {
  trimHistoryLimit(HISTORY_LIMIT, openid).catch((error) => {
    console.warn("浏览记录上限清理失败", error);
  });
}

async function recordCaseView(caseItem) {
  if (!caseItem) return null;

  let openid = "";
  try {
    openid = await ensureIdentityForHistory();
  } catch (error) {
    console.warn("静默记录浏览失败：未获取微信身份", error);
    return null;
  }
  if (!openid) return null;

  const db = getDb();
  const _ = db.command;
  const record = buildHistoryRecord(caseItem);
  let existing = null;
  const conditions = buildHistoryLookupConditions(caseItem, openid);
  for (const condition of conditions) {
    const existingResponse = await getHistoryCollection().where(condition).limit(1).get();
    existing = (existingResponse.data || [])[0] || null;
    if (existing) break;
  }

  if (existing && existing._id) {
    await getHistoryCollection().doc(existing._id).update({
      data: {
        caseDocId: record.caseDocId,
        caseId: record.caseId,
        openid,
        viewCount: _.inc(1),
        lastViewedAt: db.serverDate(),
      },
    });
    trimHistoryInBackground(openid);
    return {
      ...existing,
      ...record,
      viewCount: (existing.viewCount || 0) + 1,
    };
  }

  const response = await getHistoryCollection().add({
    data: {
      ...record,
      openid,
      viewCount: 1,
      createdAt: db.serverDate(),
      lastViewedAt: db.serverDate(),
    },
  });

  trimHistoryInBackground(openid);

  return {
    _id: response._id,
    ...record,
    viewCount: 1,
  };
}

async function clearHistory() {
  const openid = await ensureIdentityForHistory();
  if (!openid) return 0;

  let removedCount = 0;

  while (true) {
    const response = await getHistoryCollection()
      .where({ _openid: openid })
      .limit(100)
      .get();
    const ids = normalizeSelectedIds((response.data || []).map((record) => record._id || record.id));
    if (!ids.length) break;

    removedCount += await removeHistoryRecords(ids);
    if (ids.length < 100) break;
  }

  return removedCount;
}

async function fetchHistoryCasesLegacy() {
  const openid = await ensureIdentityForHistory();
  if (!openid) return [];

  const response = await getHistoryCollection()
    .where({ _openid: openid })
    .orderBy("lastViewedAt", "desc")
    .limit(HISTORY_LIMIT)
    .get();
  const historyRecords = response.data || [];
  const resolvedHistory = await Promise.all(
    historyRecords.map(async (record) => {
      try {
        return {
          record,
          caseItem: await fetchCaseById(record.caseDocId || record.caseId),
        };
      } catch (error) {
        if (isCaseNotFoundError(error)) {
          return { record, caseItem: null, isStale: true };
        }
        console.warn("浏览记录案例读取失败", record, error);
        return { record, caseItem: null };
      }
    })
  );

  const staleIds = resolvedHistory
    .filter((item) => item.isStale)
    .map((item) => item.record._id || item.record.id)
    .filter(Boolean);
  if (staleIds.length) {
    try {
      await removeHistoryRecords(staleIds);
    } catch (error) {
      console.warn("失效浏览记录清理失败", error);
    }
  }

  return mergeHistoryWithCases(
    historyRecords.filter((record) => !staleIds.includes(record._id || record.id)),
    resolvedHistory.map((item) => item.caseItem).filter(Boolean)
  );
}

async function fetchHistoryCases() {
  const openid = await ensureIdentityForHistory();
  if (!openid) return [];
  try {
    const items = await fetchUserLibrary("history");
    return items.map((item) => ({
      historyId: item.recordId,
      viewCount: item.viewCount,
      caseItem: item.caseItem,
    }));
  } catch (error) {
    console.warn("历史聚合接口不可用，使用兼容读取", error);
    return fetchHistoryCasesLegacy();
  }
}

module.exports = {
  HISTORY_COLLECTION,
  HISTORY_LIMIT,
  clearHistory,
  removeHistoryRecords,
  recordCaseView,
  fetchHistoryCases,
  fetchHistoryCasesLegacy,
  trimHistoryLimit,
};
