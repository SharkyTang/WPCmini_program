const { fetchCaseById } = require("./cloudData");
const {
  buildHistoryRecord,
  getOverflowHistoryIds,
  mergeHistoryWithCases,
  normalizeSelectedIds,
} = require("./historyData");
const { ensureWxIdentity, getCachedOpenId } = require("./userService");

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

function buildHistoryLookupConditions(caseItem) {
  const record = buildHistoryRecord(caseItem);
  const conditions = [];

  if (record.caseDocId) {
    conditions.push({ caseDocId: record.caseDocId });
  }
  if (record.caseId && record.caseId !== record.caseDocId) {
    conditions.push({ caseId: record.caseId });
  }

  if (!conditions.length) {
    return [{ caseDocId: "__missing_case__" }];
  }
  return conditions;
}

async function removeHistoryRecords(historyIds) {
  const ids = normalizeSelectedIds(historyIds);
  if (!ids.length) return 0;

  await Promise.all(ids.map((id) => getHistoryCollection().doc(id).remove()));
  return ids.length;
}

async function trimHistoryLimit(limit = HISTORY_LIMIT) {
  let removedCount = 0;

  while (true) {
    const response = await getHistoryCollection()
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

function trimHistoryInBackground() {
  trimHistoryLimit().catch((error) => {
    console.warn("浏览记录上限清理失败", error);
  });
}

async function recordCaseView(caseItem) {
  if (!caseItem) return null;

  let openid = getCachedOpenId();
  if (!openid) {
    try {
      openid = await ensureWxIdentity({ silent: true });
    } catch (error) {
      console.warn("静默记录浏览失败：未获取微信身份", error);
      return null;
    }
  }
  if (!openid) return null;

  const db = getDb();
  const _ = db.command;
  const record = buildHistoryRecord(caseItem);
  let existing = null;
  const conditions = buildHistoryLookupConditions(caseItem);
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
        viewCount: _.inc(1),
        lastViewedAt: db.serverDate(),
      },
    });
    trimHistoryInBackground();
    return {
      ...existing,
      ...record,
      viewCount: (existing.viewCount || 0) + 1,
    };
  }

  const response = await getHistoryCollection().add({
    data: {
      ...record,
      viewCount: 1,
      createdAt: db.serverDate(),
      lastViewedAt: db.serverDate(),
    },
  });

  trimHistoryInBackground();

  return {
    _id: response._id,
    ...record,
    viewCount: 1,
  };
}

async function clearHistory() {
  let removedCount = 0;

  while (true) {
    const response = await getHistoryCollection().limit(100).get();
    const ids = normalizeSelectedIds((response.data || []).map((record) => record._id || record.id));
    if (!ids.length) break;

    removedCount += await removeHistoryRecords(ids);
    if (ids.length < 100) break;
  }

  return removedCount;
}

async function fetchHistoryCases() {
  const response = await getHistoryCollection()
    .orderBy("lastViewedAt", "desc")
    .limit(HISTORY_LIMIT)
    .get();
  const historyRecords = response.data || [];
  const cases = await Promise.all(
    historyRecords.map(async (record) => {
      try {
        return await fetchCaseById(record.caseDocId || record.caseId);
      } catch (error) {
        console.warn("浏览记录案例读取失败", record, error);
        return null;
      }
    })
  );

  return mergeHistoryWithCases(historyRecords, cases.filter(Boolean));
}

module.exports = {
  HISTORY_COLLECTION,
  HISTORY_LIMIT,
  clearHistory,
  removeHistoryRecords,
  recordCaseView,
  fetchHistoryCases,
  trimHistoryLimit,
};
