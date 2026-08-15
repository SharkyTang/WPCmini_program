const {
  DEFAULT_FILTERS,
  HOME_SECTION_OPTIONS,
  getSceneLabel,
  normalizeCaseRecord,
  normalizeValues,
} = require("../../../utils/caseData");

const CASE_ADMIN_DEFAULT_SORT_ORDER = 9999;
const CASE_ADMIN_NOTES_MAX_LENGTH = 800;
const CASE_ADMIN_GALLERY_MAX = 9;
const CASE_ADMIN_VISIBILITY_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "visible", label: "显示中" },
  { value: "hidden", label: "已隐藏" },
];
const CASE_ADMIN_VIEW_OPTIONS = [
  ...CASE_ADMIN_VISIBILITY_OPTIONS,
  { value: "banner", label: "首页轮播" },
  { value: "popular", label: "热门产品" },
  { value: "latest", label: "最新产品" },
  { value: "pinned", label: "置顶" },
];
const HOME_SECTION_LABELS = HOME_SECTION_OPTIONS.reduce((labels, option) => {
  labels[option.value] = String(option.label || option.value).replace("显示", "");
  return labels;
}, {});

const CASE_ADMIN_FORM_OPTIONS = DEFAULT_FILTERS.reduce((options, filter) => {
  options[filter.key] = {
    title: filter.title,
    type: filter.type,
    options: filter.options || [],
  };
  return options;
}, {});
CASE_ADMIN_FORM_OPTIONS.homeSections = {
  title: "首页展示位置",
  type: "multi",
  options: HOME_SECTION_OPTIONS,
};

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

function optionValue(option) {
  return typeof option === "object" && option ? option.value : option;
}

function optionLabel(option, field) {
  const label = typeof option === "object" && option ? option.label || option.value : option;
  return field === "scenes" ? getSceneLabel(label) : label;
}

function isCloudFileId(value) {
  return trimText(value).startsWith("cloud://");
}

function normalizeGalleryImages(value, fallbackImage = "") {
  const images = uniqueValues([...(Array.isArray(value) ? value : []), fallbackImage]);
  return images.filter(isCloudFileId).slice(0, CASE_ADMIN_GALLERY_MAX);
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
    coverThumbnail: "",
    galleryImages: [],
    sourceGalleryImages: [],
    galleryThumbnails: [],
    wineType: "白酒",
    packageTypes: [],
    styles: [],
    priceLevel: "",
    scenes: [],
    statuses: [],
    homeSections: [],
    sortOrder: "",
    notes: "",
    isVisible: false,
    isPinned: false,
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
    views[field] = (options || []).map((option) => ({
      value: optionValue(option),
      label: optionLabel(option, field),
      selected: isCaseAdminOptionSelected(form, field, optionValue(option)),
    }));
    return views;
  }, {});
}

function normalizeCaseAdminForm(form = {}) {
  const galleryImages = normalizeGalleryImages(form.galleryImages, form.coverImage);
  const sourceGalleryImages = normalizeGalleryImages(form.sourceGalleryImages);
  const galleryThumbnails = normalizeGalleryImages(form.galleryThumbnails);
  return {
    title: trimText(form.title),
    caseId: trimText(form.caseId),
    coverImage: galleryImages[0] || trimText(form.coverImage),
    coverThumbnail: trimText(form.coverThumbnail),
    galleryImages,
    sourceGalleryImages: sourceGalleryImages.length
      ? sourceGalleryImages
      : galleryImages.slice(),
    galleryThumbnails,
    wineType: trimText(form.wineType) || "白酒",
    packageTypes: normalizeStringList(form.packageTypes),
    styles: normalizeStringList(form.styles),
    priceLevel: trimText(form.priceLevel),
    scenes: normalizeStringList(form.scenes),
    statuses: normalizeStringList(form.statuses),
    homeSections: normalizeStringList(form.homeSections),
    sortOrder: normalizeSortOrder(form.sortOrder),
    notes: trimText(form.notes),
    isVisible: form.isVisible === true,
    isPinned: form.isPinned === true,
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
  const rawGalleryImages = Array.isArray(form.galleryImages) && form.galleryImages.length
    ? form.galleryImages
    : [form.coverImage];
  if (!normalized.title) {
    return { valid: false, message: "请填写案例标题" };
  }
  if (rawGalleryImages.some((image) => trimText(image) && !isCloudFileId(image))) {
    return { valid: false, message: "封面图片需要先上传到云存储" };
  }
  if (rawGalleryImages.filter((image) => trimText(image)).length > CASE_ADMIN_GALLERY_MAX) {
    return { valid: false, message: `最多上传 ${CASE_ADMIN_GALLERY_MAX} 张图片` };
  }
  if ((options.isCreate || normalized.coverImage) && !normalized.galleryImages.length) {
    return { valid: false, message: "请上传封面图片" };
  }
  if (normalized.galleryImages.length > CASE_ADMIN_GALLERY_MAX) {
    return { valid: false, message: `最多上传 ${CASE_ADMIN_GALLERY_MAX} 张图片` };
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
    coverThumbnail: normalized.coverThumbnail,
    galleryImages: normalized.galleryImages,
    sourceGalleryImages: normalized.sourceGalleryImages,
    galleryThumbnails: normalized.galleryThumbnails,
    wineType: normalized.wineType,
    packageTypes: valuesObject(normalized.packageTypes),
    styles: valuesObject(normalized.styles),
    priceLevel: normalized.priceLevel,
    scenes: valuesObject(normalized.scenes),
    statuses: valuesObject(normalized.statuses),
    homeSections: valuesObject(normalized.homeSections),
    sortOrder: normalized.sortOrder,
    notes: normalized.notes,
    isVisible: normalized.isVisible,
    isPinned: normalized.isPinned,
    keywords: buildCaseKeywords(normalized),
  };
}

function getTagSummary(caseItem = {}) {
  return [caseItem.packageTypes && caseItem.packageTypes[0], caseItem.styles && caseItem.styles[0], caseItem.priceLevel]
    .filter(Boolean)
    .join(" / ");
}

function getHomeSectionSummary(caseItem = {}) {
  return normalizeStringList(caseItem.homeSections)
    .map((value) => HOME_SECTION_LABELS[value] || value)
    .join(" / ");
}

function getSceneSummary(caseItem = {}) {
  return normalizeStringList(caseItem.scenes)
    .map(getSceneLabel)
    .join(" / ");
}

function normalizeCaseAdminItem(record = {}) {
  const item = normalizeCaseRecord(record || {});
  const visible = item.isVisible !== false;
  return {
    ...item,
    displayKey: `case:${item.id || item.caseId || item.coverImage}`,
    visibilityStatus: visible ? "visible" : "hidden",
    visibilityLabel: visible ? "显示中" : "已隐藏",
    tagSummary: getTagSummary(item),
    sceneSummary: getSceneSummary(item),
    homeSectionSummary: getHomeSectionSummary(item),
    pinnedLabel: item.isPinned ? "默认排序置顶" : "",
    source: "case",
    sourceLabel: "案例",
  };
}

function normalizeCaseAdminHomepageDisplayItem(item = {}) {
  const source = item.source === "banner" ? "banner" : "case";
  const image = trimText(item.coverImage || item.image);
  const documentId = trimText(item.id);
  const base = source === "case"
    ? normalizeCaseAdminItem({
      ...item,
      _id: documentId || item._id,
      coverImage: image,
      isVisible: true,
    })
    : {
      id: trimText(item.id) || trimText(item.caseId) || image,
      caseId: trimText(item.caseId),
      title: trimText(item.title) || "未命名轮播图",
      coverImage: image,
      isVisible: true,
      visibilityStatus: "visible",
      visibilityLabel: "显示中",
      tagSummary: "",
      homeSectionSummary: "",
    };
  return {
    ...base,
    id: source === "case" ? documentId || base.id : base.id,
    source,
    sourceLabel: source === "banner" ? "独立轮播图" : "案例",
    displayLabel: trimText(item.displayLabel),
    displayOrder: Number(item.displayOrder) || 0,
    displayOrderLabel: trimText(item.displayOrderLabel),
    displayKey: `${source}:${base.id || base.caseId || image}`,
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
  CASE_ADMIN_GALLERY_MAX,
  CASE_ADMIN_FORM_OPTIONS,
  CASE_ADMIN_NOTES_MAX_LENGTH,
  CASE_ADMIN_VIEW_OPTIONS,
  CASE_ADMIN_VISIBILITY_OPTIONS,
  buildCaseAdminImagePath,
  buildCaseAdminOptionViews,
  buildCaseAdminPayload,
  buildCaseKeywords,
  createEmptyCaseForm,
  getHomeSectionSummary,
  getSceneLabel,
  getSceneSummary,
  isCloudFileId,
  isCaseAdminOptionSelected,
  normalizeCaseAdminForm,
  normalizeGalleryImages,
  normalizeCaseAdminHomepageDisplayItem,
  normalizeCaseAdminItem,
  normalizeCaseAdminKeyword,
  normalizeStringList,
  trimText,
  validateCaseAdminForm,
};
