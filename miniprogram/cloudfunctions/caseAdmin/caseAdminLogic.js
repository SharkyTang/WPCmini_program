const CASE_COLLECTION = "wine_packaging";
const CASE_ADMIN_DEFAULT_SORT_ORDER = 9999;
const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 50;
const SEARCH_FETCH_LIMIT = 300;

const VALID_CASE_ADMIN_ACTIONS = [
  "checkAccess",
  "listCases",
  "getCase",
  "createCase",
  "updateCase",
  "setCaseVisibility",
];

const ALLOWED_CASE_FIELDS = [
  "title",
  "caseId",
  "coverImage",
  "wineType",
  "packageTypes",
  "styles",
  "priceLevel",
  "scenes",
  "statuses",
  "sortOrder",
  "notes",
  "isVisible",
];

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getAdminOpenidsFromEnv(value) {
  return trimText(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isAdminOpenid(openid, envValue) {
  return Boolean(openid && getAdminOpenidsFromEnv(envValue).includes(openid));
}

function normalizeValues(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (Array.isArray(value.values)) return value.values.filter(Boolean);
  if (typeof value === "string") return value ? [value] : [];
  return [];
}

function uniqueValues(values = []) {
  const seen = new Set();
  return values
    .map(trimText)
    .filter(Boolean)
    .filter((value) => {
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    });
}

function valuesObject(value) {
  return {
    values: uniqueValues(normalizeValues(value)),
  };
}

function isCloudFileId(value) {
  return trimText(value).startsWith("cloud://");
}

function normalizeSortOrder(value) {
  if (value === "" || value === null || value === undefined) return CASE_ADMIN_DEFAULT_SORT_ORDER;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : CASE_ADMIN_DEFAULT_SORT_ORDER;
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

function normalizeVisibilityFilter(value) {
  return ["visible", "hidden"].includes(value) ? value : "all";
}

function generateCaseId(now = Date.now()) {
  return `case_${now}`;
}

function pickAllowedCaseFields(input = {}) {
  return ALLOWED_CASE_FIELDS.reduce((picked, field) => {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      picked[field] = input[field];
    }
    return picked;
  }, {});
}

function buildCaseKeywords(data = {}) {
  return {
    values: uniqueValues([
      data.title,
      data.caseId,
      data.wineType,
      ...normalizeValues(data.packageTypes),
      ...normalizeValues(data.styles),
      data.priceLevel,
      ...normalizeValues(data.scenes),
      ...normalizeValues(data.statuses),
    ]),
  };
}

function sanitizeCasePayload(input = {}, options = {}) {
  const picked = pickAllowedCaseFields(input);
  const data = {};
  const isCreate = options.isCreate === true;

  if (isCreate || Object.prototype.hasOwnProperty.call(picked, "title")) {
    data.title = trimText(picked.title);
    if (!data.title) return { valid: false, code: "INVALID_TITLE", message: "请填写案例标题" };
  }

  if (isCreate || Object.prototype.hasOwnProperty.call(picked, "coverImage")) {
    data.coverImage = trimText(picked.coverImage);
    if (!data.coverImage) return { valid: false, code: "INVALID_IMAGE", message: "请上传封面图片" };
    if (!isCloudFileId(data.coverImage)) {
      return { valid: false, code: "INVALID_IMAGE", message: "封面图片需要先上传到云存储" };
    }
  }

  if (isCreate || Object.prototype.hasOwnProperty.call(picked, "packageTypes")) {
    data.packageTypes = valuesObject(picked.packageTypes);
    if (!data.packageTypes.values.length) {
      return { valid: false, code: "INVALID_PACKAGE_TYPES", message: "请选择包装内容" };
    }
  }

  if (Object.prototype.hasOwnProperty.call(picked, "caseId")) {
    data.caseId = trimText(picked.caseId);
  }
  if (isCreate && !data.caseId) {
    data.caseId = generateCaseId(options.now);
  }
  if (isCreate && !data.caseId) {
    data.caseId = generateCaseId();
  }

  if (isCreate || Object.prototype.hasOwnProperty.call(picked, "wineType")) {
    data.wineType = trimText(picked.wineType) || "白酒";
  }
  if (Object.prototype.hasOwnProperty.call(picked, "styles")) {
    data.styles = valuesObject(picked.styles);
  } else if (isCreate) {
    data.styles = { values: [] };
  }
  if (Object.prototype.hasOwnProperty.call(picked, "priceLevel")) {
    data.priceLevel = trimText(picked.priceLevel);
  } else if (isCreate) {
    data.priceLevel = "";
  }
  if (Object.prototype.hasOwnProperty.call(picked, "scenes")) {
    data.scenes = valuesObject(picked.scenes);
  } else if (isCreate) {
    data.scenes = { values: [] };
  }
  if (Object.prototype.hasOwnProperty.call(picked, "statuses")) {
    data.statuses = valuesObject(picked.statuses);
  } else if (isCreate) {
    data.statuses = { values: [] };
  }
  if (Object.prototype.hasOwnProperty.call(picked, "sortOrder") || isCreate) {
    data.sortOrder = normalizeSortOrder(picked.sortOrder);
  }
  if (Object.prototype.hasOwnProperty.call(picked, "notes") || isCreate) {
    data.notes = trimText(picked.notes);
  }
  if (Object.prototype.hasOwnProperty.call(picked, "isVisible") || isCreate) {
    data.isVisible = isCreate ? false : picked.isVisible === true;
  }

  data.keywords = buildCaseKeywords(data);
  return { valid: true, data };
}

function buildCaseSearchText(item = {}) {
  return [
    item.title,
    item.caseId,
    item.wineType,
    item.priceLevel,
    item.notes,
    ...normalizeValues(item.packageTypes),
    ...normalizeValues(item.styles),
    ...normalizeValues(item.scenes),
    ...normalizeValues(item.statuses),
    ...normalizeValues(item.keywords),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function filterCaseItems(items = [], options = {}) {
  const visibility = normalizeVisibilityFilter(options.visibility);
  const keyword = trimText(options.keyword).toLowerCase();
  return items.filter((item) => {
    if (visibility === "visible" && item.isVisible === false) return false;
    if (visibility === "hidden" && item.isVisible !== false) return false;
    return !keyword || buildCaseSearchText(item).includes(keyword);
  });
}

module.exports = {
  ALLOWED_CASE_FIELDS,
  CASE_ADMIN_DEFAULT_SORT_ORDER,
  CASE_COLLECTION,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  SEARCH_FETCH_LIMIT,
  VALID_CASE_ADMIN_ACTIONS,
  buildCaseKeywords,
  buildCaseSearchText,
  filterCaseItems,
  generateCaseId,
  getAdminOpenidsFromEnv,
  isAdminOpenid,
  isCloudFileId,
  normalizePage,
  normalizePageSize,
  normalizeVisibilityFilter,
  pickAllowedCaseFields,
  sanitizeCasePayload,
  trimText,
};
