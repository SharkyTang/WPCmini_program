const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();
const INQUIRY_COLLECTION = "inquiries";
const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 50;
const SEARCH_FETCH_LIMIT = 200;
const VALID_STATUSES = ["new", "contacted", "processing", "done", "invalid"];
const ADMIN_NOTE_MAX_LENGTH = 500;

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

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getAdminOpenids() {
  return trimText(process.env.ADMIN_OPENIDS)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isAdmin(openid) {
  return Boolean(openid && getAdminOpenids().includes(openid));
}

function normalizePage(value) {
  const page = Number(value);
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}

function normalizePageSize(value) {
  const pageSize = Number(value);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return PAGE_SIZE_DEFAULT;
  return Math.min(Math.floor(pageSize), PAGE_SIZE_MAX);
}

function normalizeStatus(status) {
  return VALID_STATUSES.includes(status) ? status : "new";
}

function buildSearchText(item = {}) {
  return [
    item.contact,
    item.caseId,
    item.caseTitle,
    item.content,
    Array.isArray(item.packageTypes) ? item.packageTypes.join(" ") : "",
    Array.isArray(item.scenes) ? item.scenes.join(" ") : "",
  ]
    .join(" ")
    .toLowerCase();
}

function filterByKeyword(items, keyword) {
  const normalizedKeyword = trimText(keyword).toLowerCase();
  if (!normalizedKeyword) return items;
  return items.filter((item) => buildSearchText(item).includes(normalizedKeyword));
}

function filterByStatus(items, status) {
  if (!VALID_STATUSES.includes(status)) return items;
  return items.filter((item) => normalizeStatus(item.status) === status);
}

async function listInquiries(event) {
  const page = normalizePage(event.page);
  const pageSize = normalizePageSize(event.pageSize);
  const keyword = trimText(event.keyword);
  const status = event.status;
  const hasStatusFilter = VALID_STATUSES.includes(status);
  const query = db.collection(INQUIRY_COLLECTION);

  if (keyword || hasStatusFilter) {
    const response = await query
      .orderBy("createdAt", "desc")
      .limit(SEARCH_FETCH_LIMIT)
      .get();
    const filteredItems = filterByKeyword(
      filterByStatus(response.data || [], status),
      keyword
    );
    const start = (page - 1) * pageSize;
    const items = filteredItems.slice(start, start + pageSize);
    return ok({
      items,
      page,
      pageSize,
      hasMore: start + pageSize < filteredItems.length,
    });
  }

  const response = await query
    .orderBy("createdAt", "desc")
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

async function getInquiry(event) {
  const id = trimText(event.id);
  if (!id) return fail("INVALID_ID", "缺少需求 ID");
  const response = await db.collection(INQUIRY_COLLECTION).doc(id).get();
  return ok({ item: response.data || null });
}

async function updateInquiryStatus(event, openid) {
  const id = trimText(event.id);
  const status = normalizeStatus(event.status);
  if (!id) return fail("INVALID_ID", "缺少需求 ID");

  await db.collection(INQUIRY_COLLECTION).doc(id).update({
    data: {
      status,
      updatedAt: db.serverDate(),
      updatedByOpenid: openid,
    },
  });
  return ok({ status });
}

async function saveInquiryNote(event, openid) {
  const id = trimText(event.id);
  const adminNote = trimText(event.adminNote);
  if (!id) return fail("INVALID_ID", "缺少需求 ID");
  if (adminNote.length > ADMIN_NOTE_MAX_LENGTH) {
    return fail("INVALID_NOTE", "管理员备注最多 500 个字");
  }

  await db.collection(INQUIRY_COLLECTION).doc(id).update({
    data: {
      adminNote,
      updatedAt: db.serverDate(),
      updatedByOpenid: openid,
    },
  });
  return ok({ adminNote });
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const action = trimText(event.action);
  const admin = isAdmin(OPENID);

  if (action === "checkAccess") {
    return ok({ isAdmin: admin });
  }

  if (!admin) {
    return fail("FORBIDDEN", "无权限查看需求管理");
  }

  try {
    if (action === "listInquiries") {
      return listInquiries(event);
    }
    if (action === "getInquiry") {
      return getInquiry(event);
    }
    if (action === "updateInquiryStatus") {
      return updateInquiryStatus(event, OPENID);
    }
    if (action === "saveInquiryNote") {
      return saveInquiryNote(event, OPENID);
    }
    return fail("UNKNOWN_ACTION", "未知需求管理操作");
  } catch (error) {
    console.error("inquiryAdmin error", error);
    return fail("SERVER_ERROR", error.message || "需求管理服务异常");
  }
};
