const DEFAULT_FILTERS = [
  {
    key: "statuses",
    title: "状态",
    type: "multi",
    options: ["推荐", "热门", "新上传"],
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

const MULTI_FIELDS = ["packageTypes", "styles", "scenes", "statuses"];

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
  return (VALUE_ALIASES[field] && VALUE_ALIASES[field][value]) || value;
}

function normalizeDisplayValues(field, value) {
  return normalizeValues(value).map((item) => normalizeDisplayValue(field, item));
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

function toNumber(value, fallback = 9999) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function normalizeCaseRecord(record = {}) {
  const normalized = {
    ...record,
    id: record._id || record.caseId || "",
    caseId: record.caseId || record._id || "",
    title: record.title || record.name || "未命名案例",
    coverImage: firstImage(record.coverImage || record.image || record.images),
    wineType: record.wineType || "白酒",
    priceLevel: normalizeDisplayValue("priceLevel", record.priceLevel || ""),
    notes: record.notes || record.description || "",
    isVisible: record.isVisible !== false,
    sortOrder: toNumber(record.sortOrder ?? record.priority),
    crafts: [],
  };

  MULTI_FIELDS.forEach((field) => {
    normalized[field] = normalizeDisplayValues(field, record[field]);
  });

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

function filterCases(cases, { query = "", selectedFilters = {} } = {}) {
  const keyword = query.trim().toLowerCase();
  return cases
    .filter((caseItem) => caseItem.isVisible)
    .filter((caseItem) => !keyword || caseItem.searchText.includes(keyword))
    .filter((caseItem) =>
      Object.keys(selectedFilters).every((field) =>
        hasAnyValue(caseItem, field, selectedFilters[field])
      )
    )
    .sort((a, b) => a.sortOrder - b.sortOrder);
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
    image: firstImage(record.image || record.coverImage),
    caseId: record.caseId || "",
    sortOrder: toNumber(record.sortOrder),
  };
}

function buildFallbackBanners(banners = [], cases = []) {
  const normalizedBanners = banners
    .map(normalizeBannerRecord)
    .filter((banner) => banner.image)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  if (normalizedBanners.length) return normalizedBanners;

  return cases
    .filter((caseItem) => caseItem.coverImage)
    .filter((caseItem) => caseItem.statuses.includes("推荐"))
    .slice(0, 5)
    .map((caseItem) => ({
      id: caseItem.id,
      title: caseItem.title,
      image: caseItem.coverImage,
      caseId: caseItem.caseId || caseItem.id,
      sortOrder: caseItem.sortOrder,
    }));
}

function formatJoined(values, fallback = "未选择") {
  if (!values) return fallback;
  if (Array.isArray(values)) return values.length ? values.join(" / ") : fallback;
  return values || fallback;
}

module.exports = {
  DEFAULT_FILTERS,
  MULTI_FIELDS,
  normalizeValues,
  normalizeDisplayValue,
  normalizeDisplayValues,
  firstImage,
  normalizeCaseRecord,
  normalizeBannerRecord,
  filterCases,
  selectedFilterCount,
  buildFallbackBanners,
  formatJoined,
};
