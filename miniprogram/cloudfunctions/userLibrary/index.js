const cloud = require("wx-server-sdk");
const {
  FAVORITE_LIMIT,
  HISTORY_LIMIT,
  buildLibraryDocumentId,
  normalizeCaseReference,
  normalizeRecordIds,
  trimText,
} = require("./userLibraryLogic");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();
const _ = db.command;
const FAVORITE_COLLECTION = "favorites";
const HISTORY_COLLECTION = "browse_history";

function ok(data = {}) {
  return { ok: true, ...data };
}

function fail(code, message) {
  return { ok: false, code, message };
}

async function findByReference(database, collectionName, openid, reference) {
  const conditions = [];
  if (reference.caseDocId) {
    conditions.push({ _openid: openid, caseDocId: reference.caseDocId });
  }
  if (reference.caseId && reference.caseId !== reference.caseDocId) {
    conditions.push({ _openid: openid, caseId: reference.caseId });
  }
  for (const condition of conditions) {
    const response = await database
      .collection(collectionName)
      .where(condition)
      .limit(1)
      .get();
    const record = (response.data || [])[0];
    if (record) return record;
  }
  return null;
}

async function addFavorite(event, openid) {
  const reference = normalizeCaseReference(event.favorite || event.case || event.data);
  if (!reference) return fail("INVALID_CASE_REFERENCE", "收藏案例信息无效");

  const result = await db.runTransaction(async (transaction) => {
    const existing = await findByReference(
      transaction,
      FAVORITE_COLLECTION,
      openid,
      reference
    );
    if (existing) {
      return { favorite: existing, created: false, limitReached: false };
    }

    const countResponse = await transaction
      .collection(FAVORITE_COLLECTION)
      .where({ _openid: openid })
      .limit(FAVORITE_LIMIT)
      .get();
    if ((countResponse.data || []).length >= FAVORITE_LIMIT) {
      return { favorite: null, created: false, limitReached: true };
    }

    const id = buildLibraryDocumentId("favorites", openid, reference);
    const storedFavorite = {
      ...reference,
      _openid: openid,
      openid,
      createdAt: db.serverDate(),
    };
    await transaction.collection(FAVORITE_COLLECTION).doc(id).set({
      data: storedFavorite,
    });
    const favorite = { _id: id, ...storedFavorite };
    return { favorite, created: true, limitReached: false };
  });

  return ok(result);
}

async function removeOwnedRecords(collectionName, ids, openid) {
  const requestedIds = normalizeRecordIds(ids);
  if (!requestedIds.length) return 0;

  return db.runTransaction(async (transaction) => {
    let removedCount = 0;
    for (const id of requestedIds) {
      const response = await transaction
        .collection(collectionName)
        .where({ _id: id, _openid: openid })
        .limit(1)
        .get();
      const record = (response.data || [])[0];
      if (!record || !record._id) continue;
      await transaction.collection(collectionName).doc(record._id).remove();
      removedCount += 1;
    }
    return removedCount;
  });
}

async function clearOwnedRecords(collectionName, openid) {
  let removedCount = 0;
  while (true) {
    const response = await db
      .collection(collectionName)
      .where({ _openid: openid })
      .limit(100)
      .get();
    const ids = normalizeRecordIds(
      (response.data || []).map((record) => record._id || record.id)
    );
    if (!ids.length) break;
    removedCount += await removeOwnedRecords(collectionName, ids, openid);
    if (ids.length < 100) break;
  }
  return removedCount;
}

async function recordHistory(event, openid) {
  const reference = normalizeCaseReference(event.history || event.case || event.data);
  if (!reference) return fail("INVALID_CASE_REFERENCE", "浏览案例信息无效");

  const history = await db.runTransaction(async (transaction) => {
    const existing = await findByReference(
      transaction,
      HISTORY_COLLECTION,
      openid,
      reference
    );
    if (existing && existing._id) {
      await transaction.collection(HISTORY_COLLECTION).doc(existing._id).update({
        data: {
          ...reference,
          _openid: openid,
          openid,
          viewCount: _.inc(1),
          lastViewedAt: db.serverDate(),
        },
      });
      return {
        ...existing,
        ...reference,
        viewCount: (Number(existing.viewCount) || 0) + 1,
      };
    }

    const currentResponse = await transaction
      .collection(HISTORY_COLLECTION)
      .where({ _openid: openid })
      .orderBy("lastViewedAt", "desc")
      .limit(100)
      .get();
    const overflow = (currentResponse.data || []).slice(HISTORY_LIMIT - 1);
    for (const record of overflow) {
      if (record && record._id) {
        await transaction.collection(HISTORY_COLLECTION).doc(record._id).remove();
      }
    }

    const id = buildLibraryDocumentId("history", openid, reference);
    const storedHistory = {
      ...reference,
      _openid: openid,
      openid,
      viewCount: 1,
      createdAt: db.serverDate(),
      lastViewedAt: db.serverDate(),
    };
    await transaction.collection(HISTORY_COLLECTION).doc(id).set({
      data: storedHistory,
    });
    const created = { _id: id, ...storedHistory };
    return created;
  });

  return ok({ history });
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const action = trimText(event.action);
  if (!OPENID) return fail("UNAUTHORIZED", "未获取到微信身份");

  try {
    if (action === "addFavorite") return addFavorite(event, OPENID);
    if (action === "removeFavorites") {
      return ok({
        removedCount: await removeOwnedRecords(
          FAVORITE_COLLECTION,
          event.ids,
          OPENID
        ),
      });
    }
    if (action === "clearFavorites") {
      return ok({
        removedCount: await clearOwnedRecords(FAVORITE_COLLECTION, OPENID),
      });
    }
    if (action === "recordHistory") return recordHistory(event, OPENID);
    if (action === "removeHistory") {
      return ok({
        removedCount: await removeOwnedRecords(
          HISTORY_COLLECTION,
          event.ids,
          OPENID
        ),
      });
    }
    if (action === "clearHistory") {
      return ok({
        removedCount: await clearOwnedRecords(HISTORY_COLLECTION, OPENID),
      });
    }
    return fail("UNKNOWN_ACTION", "未知用户列表操作");
  } catch (error) {
    console.error("userLibrary error", {
      action,
      code: error && (error.code || error.errCode),
      message: error && error.message,
    });
    return fail("SERVER_ERROR", "用户列表服务暂时不可用，请重试");
  }
};
