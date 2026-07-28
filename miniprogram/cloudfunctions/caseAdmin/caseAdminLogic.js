const CASE_COLLECTION = "wine_packaging";
const BANNER_COLLECTION = "home_banners";
const CASE_ADMIN_DEFAULT_SORT_ORDER = 9999;
const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 50;
const SEARCH_FETCH_LIMIT = 300;
const IMAGE_URL_BATCH_SIZE = 50;
const CASE_GALLERY_MAX = 5;
const PINNED_CASE_LIMIT = 20;
const CASE_ID_PREFIX = "case_";
const CASE_ID_PAD_LENGTH = 3;
const CASE_ID_SEQUENCE_MAX = 999999;
const HOME_DISPLAY_LIMITS = {
  banner: 5,
  popular: 4,
  latest: 6,
};
const HOME_DISPLAY_LABELS = {
  banner: "首页轮播",
  popular: "热门产品",
  latest: "最新产品",
};

const VALID_CASE_ADMIN_ACTIONS = [
  "checkAccess",
  "listCases",
  "getCase",
  "getCaseImageUrls",
  "getVisibleImageUrls",
  "listHomepageDisplay",
  "createCase",
  "updateCase",
  "setCaseVisibility",
  "deleteCase",
];

const ALLOWED_CASE_FIELDS = [
  "title",
  "caseId",
  "coverImage",
  "coverThumbnail",
  "galleryImages",
  "wineType",
  "packageTypes",
  "styles",
  "priceLevel",
  "scenes",
  "statuses",
  "homeSections",
  "sortOrder",
  "notes",
  "isVisible",
  "isPinned",
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

function normalizeCloudFileIds(value = [], limit = IMAGE_URL_BATCH_SIZE) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value
    .map(trimText)
    .filter(isCloudFileId)
    .filter((fileID) => {
      if (seen.has(fileID)) return false;
      seen.add(fileID);
      return true;
    })
    .slice(0, limit);
}

function normalizeGalleryImages(value) {
  const rawImages = normalizeValues(value).map(trimText).filter(Boolean);
  if (rawImages.length > CASE_GALLERY_MAX) {
    return { valid: false, code: "TOO_MANY_IMAGES", message: "一个案例最多上传 5 张图片" };
  }
  if (rawImages.some((fileID) => !isCloudFileId(fileID))) {
    return { valid: false, code: "INVALID_GALLERY_IMAGE", message: "封面图片需要先上传到云存储" };
  }
  return { valid: true, images: uniqueValues(rawImages) };
}

function normalizeSortOrder(value) {
  if (value === "" || value === null || value === undefined) return CASE_ADMIN_DEFAULT_SORT_ORDER;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : CASE_ADMIN_DEFAULT_SORT_ORDER;
}

function hasUsableSortOrder(value) {
  if (value === "" || value === null || value === undefined) return false;
  return Number.isFinite(Number(value));
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
  return ["visible", "hidden", "pinned"].includes(value) ? value : "all";
}

function normalizeHomepageDisplaySlot(value) {
  return Object.prototype.hasOwnProperty.call(HOME_DISPLAY_LIMITS, value) ? value : "";
}

function getHomepageDisplayLimit(slot) {
  return HOME_DISPLAY_LIMITS[normalizeHomepageDisplaySlot(slot)] || 0;
}

function getActiveHomepageSlots(item = {}) {
  if (!item || item.isVisible !== true) return [];
  return uniqueValues(normalizeValues(item.homeSections))
    .map(normalizeHomepageDisplaySlot)
    .filter(Boolean);
}

function getActivatedHomepageSlots(existing, nextItem = {}) {
  const previousSlots = new Set(getActiveHomepageSlots(existing));
  return getActiveHomepageSlots(nextItem).filter((slot) => !previousSlots.has(slot));
}

function generateCaseId(now = Date.now()) {
  return `${CASE_ID_PREFIX}${now}`;
}

function getCaseIdNumber(value) {
  const text = trimText(value);
  const match = new RegExp(`^${CASE_ID_PREFIX}(\\d+)$`).exec(text);
  if (!match) return 0;
  const numberValue = Number(match[1]);
  if (
    !Number.isInteger(numberValue) ||
    numberValue <= 0 ||
    numberValue > CASE_ID_SEQUENCE_MAX
  ) {
    return 0;
  }
  return numberValue;
}

function formatSequentialCaseId(numberValue) {
  return `${CASE_ID_PREFIX}${String(numberValue).padStart(CASE_ID_PAD_LENGTH, "0")}`;
}

function generateSequentialCaseId(items = []) {
  const maxNumber = items.reduce((max, item) => {
    return Math.max(max, getCaseIdNumber(item && item.caseId));
  }, 0);
  return formatSequentialCaseId(maxNumber + 1);
}

function getCreateSortOrder(value, caseId, options = {}) {
  if (hasUsableSortOrder(value)) return normalizeSortOrder(value);
  const caseNumber = getCaseIdNumber(caseId);
  if (caseNumber) return caseNumber;
  if (hasUsableSortOrder(options.defaultSortOrder)) {
    return normalizeSortOrder(options.defaultSortOrder);
  }
  return CASE_ADMIN_DEFAULT_SORT_ORDER;
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

  const hasGalleryInput = Object.prototype.hasOwnProperty.call(picked, "galleryImages");
  const hasCoverInput = Object.prototype.hasOwnProperty.call(picked, "coverImage");
  if (isCreate || hasGalleryInput || hasCoverInput) {
    const galleryResult = normalizeGalleryImages(
      hasGalleryInput ? picked.galleryImages : [picked.coverImage]
    );
    if (!galleryResult.valid) return galleryResult;
    if (!galleryResult.images.length) {
      return { valid: false, code: "INVALID_IMAGE", message: "请上传封面图片" };
    }
    data.galleryImages = galleryResult.images;
    // 服务端以首图为准，避免客户端传入的封面与图库顺序不一致。
    data.coverImage = galleryResult.images[0];
  }
  if (Object.prototype.hasOwnProperty.call(picked, "coverThumbnail")) {
    data.coverThumbnail = trimText(picked.coverThumbnail);
    if (data.coverThumbnail && !isCloudFileId(data.coverThumbnail)) {
      return { valid: false, code: "INVALID_THUMBNAIL", message: "缩略图需要先上传到云存储" };
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
    data.caseId = trimText(options.defaultCaseId) || generateCaseId(options.now);
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
  if (Object.prototype.hasOwnProperty.call(picked, "homeSections")) {
    data.homeSections = valuesObject(picked.homeSections);
  } else if (isCreate) {
    data.homeSections = { values: [] };
  }
  if (Object.prototype.hasOwnProperty.call(picked, "sortOrder") || isCreate) {
    data.sortOrder = isCreate
      ? getCreateSortOrder(picked.sortOrder, data.caseId, options)
      : normalizeSortOrder(picked.sortOrder);
  }
  if (Object.prototype.hasOwnProperty.call(picked, "notes") || isCreate) {
    data.notes = trimText(picked.notes);
  }
  if (Object.prototype.hasOwnProperty.call(picked, "isVisible") || isCreate) {
    data.isVisible = picked.isVisible === true;
  }
  if (Object.prototype.hasOwnProperty.call(picked, "isPinned") || isCreate) {
    data.isPinned = picked.isPinned === true;
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
    if (visibility === "pinned" && item.isPinned !== true) return false;
    return !keyword || buildCaseSearchText(item).includes(keyword);
  });
}

function sortBySortOrder(items = [], direction = "asc") {
  const multiplier = direction === "desc" ? -1 : 1;
  return items.slice().sort((left, right) => {
    const difference = normalizeSortOrder(left && left.sortOrder) - normalizeSortOrder(right && right.sortOrder);
    return difference === 0 ? 0 : difference * multiplier;
  });
}

function buildHomepageDisplayItem(item = {}, options = {}) {
  const slot = normalizeHomepageDisplaySlot(options.slot);
  const source = options.source === "banner" ? "banner" : "case";
  const image = source === "banner" ? trimText(item.image) : trimText(item.coverImage);
  return {
    id: item._id || item.caseId || image,
    caseId: trimText(item.caseId),
    title: trimText(item.title) || (source === "banner" ? "未命名轮播图" : "未命名案例"),
    coverImage: image,
    image,
    sortOrder: normalizeSortOrder(item.sortOrder),
    isVisible: item.isVisible !== false,
    source,
    sourceLabel: source === "banner" ? "独立轮播图" : "案例",
    displaySlot: slot,
    displayLabel: HOME_DISPLAY_LABELS[slot] || "首页展示",
    homeSections: normalizeValues(item.homeSections),
    packageTypes: normalizeValues(item.packageTypes),
    styles: normalizeValues(item.styles),
    priceLevel: trimText(item.priceLevel),
  };
}

function buildHomepageDisplaySearchText(item = {}) {
  return [
    item.title,
    item.caseId,
    item.displayLabel,
    item.sourceLabel,
    ...normalizeValues(item.packageTypes),
    ...normalizeValues(item.styles),
    item.priceLevel,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function filterHomepageDisplayItems(items = [], keyword = "") {
  const normalizedKeyword = trimText(keyword).toLowerCase();
  if (!normalizedKeyword) return items.slice();
  return items.filter((item) => buildHomepageDisplaySearchText(item).includes(normalizedKeyword));
}

function buildHomepageDisplayItems(cases = [], banners = [], options = {}) {
  const slot = normalizeHomepageDisplaySlot(options.slot);
  const limit = getHomepageDisplayLimit(slot);
  if (!slot || !limit) return [];

  const visibleCases = cases.filter((item) => item && item.isVisible === true);
  let items;

  if (slot === "banner") {
    const visibleBanners = banners
      .filter((item) => item && item.isVisible === true)
      .map((item) => buildHomepageDisplayItem(item, { slot, source: "banner" }));
    const caseBanners = visibleCases
      .filter((item) => normalizeValues(item.homeSections).includes(slot))
      .map((item) => buildHomepageDisplayItem(item, { slot, source: "case" }));
    const seen = new Set();
    items = sortBySortOrder(visibleBanners).concat(sortBySortOrder(caseBanners)).filter((item) => {
      const key = item.caseId || item.image || item.id;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } else {
    const direction = slot === "latest" ? "desc" : "asc";
    items = sortBySortOrder(
      visibleCases
        .filter((item) => normalizeValues(item.homeSections).includes(slot))
        .map((item) => buildHomepageDisplayItem(item, { slot, source: "case" })),
      direction
    );
  }

  const limitedItems = options.applyLimit === false ? items : items.slice(0, limit);
  const displayedItems = limitedItems.map((item, index) => {
    const displayOrder = index + 1;
    return {
      ...item,
      displayOrder,
      displayOrderLabel: `第 ${displayOrder} ${slot === "banner" ? "张" : "个"}`,
    };
  });
  return filterHomepageDisplayItems(displayedItems, options.keyword);
}

function validateHomepageDisplayCapacity(cases = [], banners = [], candidate = {}, options = {}) {
  const excludedId = trimText(options.excludedId);
  const candidateId = trimText(candidate._id || candidate.id);
  const slots = uniqueValues(
    options.slots === undefined ? getActiveHomepageSlots(candidate) : normalizeValues(options.slots)
  )
    .map(normalizeHomepageDisplaySlot)
    .filter(Boolean);
  if (!slots.length) return { valid: true };

  const nextCases = cases
    .filter((item) => {
      const itemId = trimText(item && (item._id || item.id));
      return !excludedId || itemId !== excludedId;
    })
    .concat(candidate && candidate.isVisible === true
      ? [{ ...candidate, _id: candidateId || excludedId || candidate._id }]
      : []);

  for (const slot of slots) {
    const limit = getHomepageDisplayLimit(slot);
    const items = buildHomepageDisplayItems(nextCases, banners, {
      slot,
      applyLimit: false,
    });
    if (items.length > limit) {
      const label = HOME_DISPLAY_LABELS[slot];
      const unit = slot === "banner" ? "张" : "个";
      return {
        valid: false,
        code: "HOME_DISPLAY_LIMIT_REACHED",
        slot,
        limit,
        message: `${label}最多展示 ${limit} ${unit}，请先取消其他案例${slot === "banner" ? "或轮播图" : ""}的${label}显示`,
      };
    }
  }

  return { valid: true };
}

module.exports = {
  ALLOWED_CASE_FIELDS,
  BANNER_COLLECTION,
  CASE_ADMIN_DEFAULT_SORT_ORDER,
  CASE_COLLECTION,
  CASE_GALLERY_MAX,
  IMAGE_URL_BATCH_SIZE,
  HOME_DISPLAY_LABELS,
  HOME_DISPLAY_LIMITS,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  PINNED_CASE_LIMIT,
  SEARCH_FETCH_LIMIT,
  VALID_CASE_ADMIN_ACTIONS,
  buildCaseKeywords,
  buildCaseSearchText,
  buildHomepageDisplayItems,
  buildHomepageDisplaySearchText,
  filterCaseItems,
  filterHomepageDisplayItems,
  generateCaseId,
  generateSequentialCaseId,
  getActivatedHomepageSlots,
  getActiveHomepageSlots,
  getAdminOpenidsFromEnv,
  getCaseIdNumber,
  isAdminOpenid,
  isCloudFileId,
  normalizeCloudFileIds,
  normalizeGalleryImages,
  normalizePage,
  normalizePageSize,
  normalizeHomepageDisplaySlot,
  normalizeVisibilityFilter,
  pickAllowedCaseFields,
  sanitizeCasePayload,
  trimText,
  validateHomepageDisplayCapacity,
};
