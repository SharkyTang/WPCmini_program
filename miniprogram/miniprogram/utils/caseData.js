const DEFAULT_FILTERS = [
  {
    key: "statuses",
    title: "状态",
    type: "multi",
    options: ["热门产品", "最新产品"],
  },
  {
    key: "wineType",
    title: "酒类",
    type: "single",
    options: ["白酒"],
  },
  {
    key: "packageTypes",
    title: "包装内容",
    type: "multi",
    options: ["整套包装", "瓶标", "瓶子", "礼盒", "桶盒", "卡盒", "手提袋", "外箱"],
  },
  {
    key: "styles",
    title: "风格",
    type: "multi",
    options: ["轻奢", "国风", "新中式", "复古", "简约", "商务", "时尚", "喜庆"],
  },
  {
    key: "priceLevel",
    title: "价位感",
    type: "single",
    options: ["基础款", "品质款", "高端款", "珍藏款"],
  },
  {
    key: "scenes",
    title: "使用场景",
    type: "multi",
    options: ["婚宴", "送礼", "商务招待", "节庆礼赠", "商超陈列", "电商展示", "企业纪念"],
  },
];

const HOME_SECTION_VALUES = {
  BANNER: "banner",
  POPULAR: "popular",
  LATEST: "latest",
};

const HOME_SECTION_OPTIONS = [
  { value: HOME_SECTION_VALUES.BANNER, label: "首页轮播显示" },
  { value: HOME_SECTION_VALUES.POPULAR, label: "热门产品显示" },
  { value: HOME_SECTION_VALUES.LATEST, label: "最新产品显示" },
];

const MULTI_FIELDS = ["packageTypes", "styles", "scenes", "statuses", "homeSections"];

const VALUE_ALIASES = {
  styles: {
    高端: "轻奢",
    国潮: "国风",
  },
  priceLevel: {
    低端: "基础款",
    中端: "品质款",
    高端: "高端款",
    奢华: "珍藏款",
  },
  statuses: {
    推荐: "",
    热门: "热门产品",
    新上传: "最新产品",
    最新: "最新产品",
  },
  homeSections: {
    首页轮播: HOME_SECTION_VALUES.BANNER,
    首页轮播显示: HOME_SECTION_VALUES.BANNER,
    推荐: HOME_SECTION_VALUES.BANNER,
    热门产品显示: HOME_SECTION_VALUES.POPULAR,
    最新产品显示: HOME_SECTION_VALUES.LATEST,
  },
};

function normalizeValues(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (Array.isArray(value.values)) return value.values.filter(Boolean);
  if (typeof value === "string") return value ? [value] : [];
  return [];
}

function normalizeDisplayValue(field, value) {
  if (!value) return value;
  if (
    VALUE_ALIASES[field] &&
    Object.prototype.hasOwnProperty.call(VALUE_ALIASES[field], value)
  ) {
    return VALUE_ALIASES[field][value];
  }
  return value;
}

function normalizeDisplayValues(field, value) {
  const seen = new Set();
  return normalizeValues(value)
    .map((item) => normalizeDisplayValue(field, item))
    .filter(Boolean)
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

function inferLegacyHomeSections(record = {}) {
  const legacyStatuses = normalizeValues(record.statuses);
  return legacyStatuses.includes("推荐") ? [HOME_SECTION_VALUES.BANNER] : [];
}

function firstImage(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return firstImage(value[0]);
  if (value.fileID) return value.fileID;
  if (value.cloudID) return value.cloudID;
  if (value.url) return value.url;
  if (value.tempFileURL) return value.tempFileURL;
  return "";
}

function normalizeGalleryImages(value, fallbackImage = "") {
  const seen = new Set();
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return [...values, fallbackImage]
    .map(firstImage)
    .filter(Boolean)
    .filter((fileID) => {
      if (seen.has(fileID)) return false;
      seen.add(fileID);
      return true;
    })
    .slice(0, 5);
}

function toNumber(value, fallback = 9999) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function normalizeCaseRecord(record = {}) {
  const legacyCoverImage = firstImage(record.coverImage || record.image || record.images);
  const galleryImages = normalizeGalleryImages(record.galleryImages, legacyCoverImage);
  const normalizedSourceImages = normalizeGalleryImages(record.sourceGalleryImages);
  const sourceGalleryImages = normalizedSourceImages.length
    ? normalizedSourceImages
    : galleryImages.slice();
  const galleryThumbnails = normalizeGalleryImages(record.galleryThumbnails);
  const galleryBanners = normalizeGalleryImages(record.galleryBanners);
  const normalized = {
    ...record,
    id: record._id || record.caseId || "",
    caseId: record.caseId || record._id || "",
    title: record.title || record.name || "未命名案例",
    // 旧案例没有图库时以原封面作为唯一图片，保持完全兼容。
    galleryImages,
    sourceGalleryImages,
    galleryThumbnails,
    galleryBanners,
    coverImage: galleryImages[0] || legacyCoverImage,
    coverThumbnail: firstImage(record.coverThumbnail),
    coverBanner:
      firstImage(record.coverBanner) || galleryBanners[0] || galleryImages[0] || legacyCoverImage,
    imageVariantVersion: Number(record.imageVariantVersion) || 0,
    wineType: record.wineType || "白酒",
    priceLevel: normalizeDisplayValue("priceLevel", record.priceLevel || ""),
    notes: record.notes || record.description || "",
    isVisible: record.isVisible !== false,
    isPinned: record.isPinned === true,
    sortOrder: toNumber(record.sortOrder ?? record.priority),
    crafts: [],
  };

  MULTI_FIELDS.forEach((field) => {
    normalized[field] = normalizeDisplayValues(field, record[field]);
  });
  normalized.homeSections = [
    ...new Set([...normalized.homeSections, ...inferLegacyHomeSections(record)]),
  ];

  normalized.tags = [
    ...normalized.packageTypes,
    ...normalized.styles,
    normalized.priceLevel,
    ...normalized.scenes,
    ...normalized.statuses,
  ].filter(Boolean);
  normalized.searchText = [
    normalized.title,
    normalized.wineType,
    normalized.priceLevel,
    normalized.notes,
    ...normalized.tags,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return normalized;
}

function hasAnyValue(caseItem, field, selectedValues) {
  if (!selectedValues || !selectedValues.length) return true;
  const caseValue = caseItem[field];
  if (Array.isArray(caseValue)) {
    return selectedValues.some((value) => caseValue.includes(value));
  }
  return selectedValues.includes(caseValue);
}

function filterCases(cases, { query = "", selectedFilters = {}, pinnedFirst = false } = {}) {
  const keyword = query.trim().toLowerCase();
  return cases
    .filter((caseItem) => caseItem.isVisible)
    .filter((caseItem) => !keyword || caseItem.searchText.includes(keyword))
    .filter((caseItem) =>
      Object.keys(selectedFilters).every((field) =>
        hasAnyValue(caseItem, field, selectedFilters[field])
      )
    )
    .sort((a, b) => {
      if (pinnedFirst && Boolean(a.isPinned) !== Boolean(b.isPinned)) {
        return a.isPinned ? -1 : 1;
      }
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return String(a.caseId || a.id).localeCompare(String(b.caseId || b.id));
    });
}

function selectedFilterCount(selectedFilters = {}) {
  return Object.keys(selectedFilters).reduce(
    (count, key) => count + (selectedFilters[key] || []).length,
    0
  );
}

function normalizeBannerRecord(record = {}) {
  return {
    id: record._id || record.caseId || record.title || "",
    title: record.title || "",
    image: firstImage(record.optimizedImage || record.image || record.coverImage),
    optimizedImage: firstImage(record.optimizedImage),
    imageVariantVersion: Number(record.imageVariantVersion) || 0,
    caseId: record.caseId || "",
    sortOrder: toNumber(record.sortOrder),
  };
}

function buildFallbackBanners(banners = [], cases = []) {
  const normalizedBanners = banners
    .map(normalizeBannerRecord)
    .filter((banner) => banner.image)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const caseBanners = cases
    .filter((caseItem) => caseItem.coverBanner || caseItem.coverImage)
    .filter((caseItem) => (caseItem.homeSections || []).includes(HOME_SECTION_VALUES.BANNER))
    .map((caseItem) => ({
      id: caseItem.id,
      title: caseItem.title,
      image: caseItem.coverBanner || caseItem.coverImage,
      caseId: caseItem.caseId || caseItem.id,
      sortOrder: caseItem.sortOrder,
    }));
  const seen = new Set();

  return [...normalizedBanners, ...caseBanners]
    .filter((banner) => {
      const key = banner.caseId || banner.image || banner.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
}

function formatJoined(values, fallback = "未选择") {
  if (!values) return fallback;
  if (Array.isArray(values)) return values.length ? values.join(" / ") : fallback;
  return values || fallback;
}

module.exports = {
  DEFAULT_FILTERS,
  HOME_SECTION_OPTIONS,
  HOME_SECTION_VALUES,
  MULTI_FIELDS,
  normalizeValues,
  normalizeDisplayValue,
  normalizeDisplayValues,
  firstImage,
  normalizeGalleryImages,
  normalizeCaseRecord,
  normalizeBannerRecord,
  filterCases,
  selectedFilterCount,
  buildFallbackBanners,
  formatJoined,
};
