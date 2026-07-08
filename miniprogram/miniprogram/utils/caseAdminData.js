const { DEFAULT_FILTERS, normalizeCaseRecord, normalizeValues } = require("./caseData");

const CASE_ADMIN_DEFAULT_SORT_ORDER = 9999;
const CASE_ADMIN_NOTES_MAX_LENGTH = 800;
const CASE_ADMIN_VISIBILITY_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "visible", label: "显示中" },
  { value: "hidden", label: "已隐藏" },
];

const CASE_ADMIN_FORM_OPTIONS = DEFAULT_FILTERS.reduce((options, filter) => {
  options[filter.key] = {
    title: filter.title,
    type: filter.type,
    options: filter.options || [],
  };
  return options;
}, {});

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
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

function normalizeStringList(value) {
  return uniqueValues(normalizeValues(value));
}

function isCloudFileId(value) {
  return trimText(value).startsWith("cloud://");
}

function normalizeSortOrder(value) {
  if (value === "" || value === null || value === undefined) return "";
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : "";
}

function createEmptyCaseForm() {
  return {
    title: "",
    caseId: "",
    coverImage: "",
    wineType: "白酒",
    packageTypes: [],
    styles: [],
    priceLevel: "",
    scenes: [],
    statuses: [],
    sortOrder: "",
    notes: "",
    isVisible: false,
  };
}

function isCaseAdminOptionSelected(form = {}, field, value) {
  if (field === "priceLevel") {
    return trimText(form.priceLevel) === value;
  }
  return Array.isArray(form[field]) && form[field].includes(value);
}

function buildCaseAdminOptionViews(form = {}, formOptions = CASE_ADMIN_FORM_OPTIONS) {
  return Object.keys(formOptions).reduce((views, field) => {
    const options = formOptions[field] && formOptions[field].options;
    views[field] = (options || []).map((value) => ({
      value,
      selected: isCaseAdminOptionSelected(form, field, value),
    }));
    return views;
  }, {});
}

function normalizeCaseAdminForm(form = {}) {
  return {
    title: trimText(form.title),
    caseId: trimText(form.caseId),
    coverImage: trimText(form.coverImage),
    wineType: trimText(form.wineType) || "白酒",
    packageTypes: normalizeStringList(form.packageTypes),
    styles: normalizeStringList(form.styles),
    priceLevel: trimText(form.priceLevel),
    scenes: normalizeStringList(form.scenes),
    statuses: normalizeStringList(form.statuses),
    sortOrder: normalizeSortOrder(form.sortOrder),
    notes: trimText(form.notes),
    isVisible: form.isVisible === true,
  };
}

function buildCaseKeywords(form = {}) {
  const normalized = normalizeCaseAdminForm(form);
  return {
    values: uniqueValues([
      normalized.title,
      normalized.caseId,
      normalized.wineType,
      ...normalized.packageTypes,
      ...normalized.styles,
      normalized.priceLevel,
      ...normalized.scenes,
      ...normalized.statuses,
    ]),
  };
}

function valuesObject(values = []) {
  return {
    values: uniqueValues(values),
  };
}

function validateCaseAdminForm(form = {}, options = {}) {
  const normalized = normalizeCaseAdminForm(form);
  if (!normalized.title) {
    return { valid: false, message: "请填写案例标题" };
  }
  if ((options.isCreate || normalized.coverImage) && !normalized.coverImage) {
    return { valid: false, message: "请上传封面图片" };
  }
  if (normalized.coverImage && !isCloudFileId(normalized.coverImage)) {
    return { valid: false, message: "封面图片需要先上传到云存储" };
  }
  if (!normalized.packageTypes.length) {
    return { valid: false, message: "请选择包装内容" };
  }
  if (normalized.notes.length > CASE_ADMIN_NOTES_MAX_LENGTH) {
    return { valid: false, message: "备注最多 800 个字" };
  }
  if (form.sortOrder !== "" && normalized.sortOrder === "") {
    return { valid: false, message: "排序需要填写数字" };
  }
  return { valid: true, message: "", data: normalized };
}

function buildCaseAdminPayload(form = {}) {
  const normalized = normalizeCaseAdminForm(form);
  return {
    title: normalized.title,
    caseId: normalized.caseId,
    coverImage: normalized.coverImage,
    wineType: normalized.wineType,
    packageTypes: valuesObject(normalized.packageTypes),
    styles: valuesObject(normalized.styles),
    priceLevel: normalized.priceLevel,
    scenes: valuesObject(normalized.scenes),
    statuses: valuesObject(normalized.statuses),
    sortOrder: normalized.sortOrder,
    notes: normalized.notes,
    isVisible: normalized.isVisible,
    keywords: buildCaseKeywords(normalized),
  };
}

function getTagSummary(caseItem = {}) {
  return [caseItem.packageTypes && caseItem.packageTypes[0], caseItem.styles && caseItem.styles[0], caseItem.priceLevel]
    .filter(Boolean)
    .join(" / ");
}

function normalizeCaseAdminItem(record = {}) {
  const item = normalizeCaseRecord(record || {});
  const visible = item.isVisible !== false;
  return {
    ...item,
    visibilityStatus: visible ? "visible" : "hidden",
    visibilityLabel: visible ? "显示中" : "已隐藏",
    tagSummary: getTagSummary(item),
  };
}

function normalizeCaseAdminKeyword(keyword) {
  return trimText(keyword);
}

function buildCaseAdminImagePath(filePath = "", now = Date.now(), random = Math.random()) {
  const extMatch = String(filePath).match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
  const ext = extMatch ? extMatch[1].toLowerCase() : "jpg";
  const safeExt = ["jpg", "jpeg", "png", "webp"].includes(ext) ? ext : "jpg";
  const randomPart = String(random).replace(/\D/g, "").slice(0, 8) || "00000000";
  return `wine-packaging/admin/${now}-${randomPart}.${safeExt}`;
}

module.exports = {
  CASE_ADMIN_DEFAULT_SORT_ORDER,
  CASE_ADMIN_FORM_OPTIONS,
  CASE_ADMIN_NOTES_MAX_LENGTH,
  CASE_ADMIN_VISIBILITY_OPTIONS,
  buildCaseAdminImagePath,
  buildCaseAdminOptionViews,
  buildCaseAdminPayload,
  buildCaseKeywords,
  createEmptyCaseForm,
  isCloudFileId,
  isCaseAdminOptionSelected,
  normalizeCaseAdminForm,
  normalizeCaseAdminItem,
  normalizeCaseAdminKeyword,
  normalizeStringList,
  trimText,
  validateCaseAdminForm,
};
