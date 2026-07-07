const cloud = require("wx-server-sdk");
const {
  CASE_COLLECTION,
  SEARCH_FETCH_LIMIT,
  filterCaseItems,
  isAdminOpenid,
  normalizePage,
  normalizePageSize,
  normalizeVisibilityFilter,
  sanitizeCasePayload,
  trimText,
} = require("./caseAdminLogic");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();

function ok(data = {}) {
  return {
    ok: true,
    ...data,
  };
}

function fail(code, message) {
  return {
    ok: false,
    code,
    message,
  };
}

async function listCases(event) {
  const page = normalizePage(event.page);
  const pageSize = normalizePageSize(event.pageSize);
  const visibility = normalizeVisibilityFilter(event.visibility);
  const keyword = trimText(event.keyword);
  const query = db.collection(CASE_COLLECTION);

  if (keyword || visibility !== "all") {
    const response = await query
      .orderBy("sortOrder", "asc")
      .limit(SEARCH_FETCH_LIMIT)
      .get();
    const filteredItems = filterCaseItems(response.data || [], {
      keyword,
      visibility,
    });
    const start = (page - 1) * pageSize;
    return ok({
      items: filteredItems.slice(start, start + pageSize),
      page,
      pageSize,
      hasMore: start + pageSize < filteredItems.length,
    });
  }

  const response = await query
    .orderBy("sortOrder", "asc")
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get();

  return ok({
    items: response.data || [],
    page,
    pageSize,
    hasMore: (response.data || []).length === pageSize,
  });
}

async function getCase(event) {
  const id = trimText(event.id);
  if (!id) return fail("INVALID_ID", "缺少案例 ID");
  const response = await db.collection(CASE_COLLECTION).doc(id).get();
  return ok({ item: response.data || null });
}

async function createCase(event, openid) {
  const input = event.case || event.data || {};
  const result = sanitizeCasePayload(input, {
    isCreate: true,
    now: Date.now(),
  });
  if (!result.valid) return fail(result.code, result.message);

  const response = await db.collection(CASE_COLLECTION).add({
    data: {
      ...result.data,
      createdAt: db.serverDate(),
      updatedAt: db.serverDate(),
      createdByOpenid: openid,
      updatedByOpenid: openid,
    },
  });

  return ok({
    id: response._id,
    caseId: result.data.caseId,
  });
}

async function updateCase(event, openid) {
  const id = trimText(event.id);
  if (!id) return fail("INVALID_ID", "缺少案例 ID");

  const input = event.case || event.data || {};
  const result = sanitizeCasePayload(input, { isCreate: false });
  if (!result.valid) return fail(result.code, result.message);

  await db.collection(CASE_COLLECTION).doc(id).update({
    data: {
      ...result.data,
      updatedAt: db.serverDate(),
      updatedByOpenid: openid,
    },
  });

  return ok({ id });
}

async function setCaseVisibility(event, openid) {
  const id = trimText(event.id);
  if (!id) return fail("INVALID_ID", "缺少案例 ID");

  await db.collection(CASE_COLLECTION).doc(id).update({
    data: {
      isVisible: event.isVisible === true,
      updatedAt: db.serverDate(),
      updatedByOpenid: openid,
    },
  });

  return ok({
    id,
    isVisible: event.isVisible === true,
  });
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const action = trimText(event.action);
  const admin = isAdminOpenid(OPENID, process.env.ADMIN_OPENIDS);

  if (action === "checkAccess") {
    return ok({ isAdmin: admin });
  }

  if (!admin) {
    return fail("FORBIDDEN", "无权限管理案例");
  }

  try {
    if (action === "listCases") return listCases(event);
    if (action === "getCase") return getCase(event);
    if (action === "createCase") return createCase(event, OPENID);
    if (action === "updateCase") return updateCase(event, OPENID);
    if (action === "setCaseVisibility") return setCaseVisibility(event, OPENID);
    return fail("UNKNOWN_ACTION", "未知案例管理操作");
  } catch (error) {
    console.error("caseAdmin error", error);
    return fail("SERVER_ERROR", error.message || "案例管理服务异常");
  }
};
