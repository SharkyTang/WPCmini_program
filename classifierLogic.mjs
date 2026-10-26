export const CLASSIFIER_STORAGE_KEY = "wine-case-classifier-v0";
export const IMAGE_QUALITY = 0.85;
export const MAX_IMAGE_EDGE = 1600;
export const SOFT_SIZE_LIMIT_KB = 1024;

const VALUE_MIGRATIONS = {
  styles: {
    "传统": "复古",
    "节日": "喜庆",
    "年轻化": "时尚",
    "国潮": "国风",
    "高端": "轻奢"
  },
  priceLevel: {
    "低端": "基础款",
    "中端": "品质款",
    "高端": "高端款",
    "奢华": "珍藏款"
  },
  statuses: {
    "推荐": "",
    "热门": "热门产品",
    "新上传": "最新产品",
    "最新": "最新产品"
  },
  scenes: {
    "婚宴/喜宴": "婚宴",
    "喜宴": "婚宴"
  }
};

export const SCENE_VALUES = Object.freeze([
  "婚宴",
  "百日/满月",
  "生日宴",
  "寿宴",
  "乔迁宴",
  "送礼",
  "商务招待",
  "节庆礼赠",
  "企业纪念",
  "商超陈列",
  "电商展示"
]);

const SCENE_LABELS = Object.freeze({
  "婚宴": "婚宴/喜宴"
});

export function getSceneLabel(value) {
  const normalizedValue = normalizeFieldValue("scenes", value);
  return SCENE_LABELS[normalizedValue] || normalizedValue;
}

export const CLASSIFICATION_CONFIG = {
  wineType: {
    label: "酒类",
    type: "single",
    required: true,
    options: ["白酒"]
  },
  packageTypes: {
    label: "包装",
    type: "multi",
    required: true,
    options: ["整套包装", "瓶标", "瓶子", "礼盒", "桶盒", "卡盒", "手提袋", "外箱"]
  },
  styles: {
    label: "风格",
    type: "multi",
    required: false,
    options: ["轻奢", "国风", "新中式", "复古", "简约", "商务", "时尚", "喜庆"]
  },
  priceLevel: {
    label: "定位",
    type: "single",
    required: false,
    options: ["基础款", "品质款", "高端款", "珍藏款"]
  },
  scenes: {
    label: "场景",
    type: "multi",
    required: false,
    options: SCENE_VALUES
  },
  statuses: {
    label: "状态",
    type: "multi",
    required: false,
    options: ["热门产品", "最新产品"]
  }
};

export function isSupportedImageFile(file) {
  const name = file?.name || "";
  const type = file?.type || "";
  return (
    /^image\/(jpeg|png)$/i.test(type) ||
    /\.(jpe?g|png)$/i.test(name)
  );
}

export function sortImageFiles(files) {
  return [...files]
    .filter(isSupportedImageFile)
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true, sensitivity: "base" }));
}

export function createCaseId(index) {
  return `case_${String(index + 1).padStart(3, "0")}`;
}

export function fileSizeKB(size = 0) {
  return Math.round(size / 1024);
}

export function createEmptyRecord(file, index, previous = null) {
  const id = createCaseId(index);
  const base = {
    id,
    title: "",
    originalFileName: file.name,
    uploadFileName: `${id}.jpg`,
    wineType: "白酒",
    packageTypes: [],
    styles: [],
    priceLevel: "",
    scenes: [],
    statuses: [],
    keywords: [],
    notes: "",
    width: 0,
    height: 0,
    aspectRatio: 0,
    originalSizeKB: fileSizeKB(file.size),
    optimizedSizeKB: 0,
    imageFileID: "",
    isVisible: true,
    sortOrder: index + 1,
    needsReview: false,
    completed: false,
    skipped: false
  };

  if (!previous) return sanitizeRecord(base);

  return sanitizeRecord({
    ...base,
    ...previous,
    id,
    originalFileName: file.name,
    uploadFileName: `${id}.jpg`,
    originalSizeKB: fileSizeKB(file.size),
    sortOrder: index + 1
  });
}

export function imageSignature(file) {
  return `${file.name}::${file.size || 0}::${file.lastModified || 0}`;
}

export function toggleMultiValue(record, field, value) {
  const values = normalizeFieldValues(field, record[field]);
  const normalizedValue = normalizeFieldValue(field, value);
  const next = values.includes(normalizedValue) ? values.filter((item) => item !== normalizedValue) : [...values, normalizedValue];
  return { ...record, [field]: next };
}

export function setSingleValue(record, field, value) {
  return { ...record, [field]: record[field] === value ? "" : value };
}

export function setRequiredSingleValue(record, field, value) {
  return { ...record, [field]: value };
}

export function buildKeywords(record) {
  const cleanRecord = sanitizeRecord(record);
  const values = [
    cleanRecord.wineType,
    ...(cleanRecord.packageTypes || []),
    ...(cleanRecord.styles || []),
    cleanRecord.priceLevel,
    ...(cleanRecord.scenes || []),
    ...(cleanRecord.statuses || [])
  ].filter(Boolean);

  return [...new Set(values)];
}

export function validateRecord(record) {
  const cleanRecord = sanitizeRecord(record);
  const errors = [];
  if (!cleanRecord.wineType) errors.push("缺酒类");
  if (!cleanRecord.packageTypes?.length) errors.push("缺包装内容");
  return errors;
}

export function isComplete(record) {
  return validateRecord(record).length === 0;
}

export function buildExportRecord(record, optimized = {}) {
  const cleanRecord = sanitizeRecord(record);
  const width = optimized.width || record.width || 0;
  const height = optimized.height || record.height || 0;
  const optimizedSizeKB = optimized.optimizedSizeKB ?? record.optimizedSizeKB ?? 0;
  return {
    id: cleanRecord.id,
    title: cleanRecord.title?.trim() || "",
    originalFileName: cleanRecord.originalFileName,
    uploadFileName: cleanRecord.uploadFileName,
    wineType: cleanRecord.wineType,
    packageTypes: cleanRecord.packageTypes || [],
    styles: cleanRecord.styles || [],
    priceLevel: cleanRecord.priceLevel || "",
    scenes: cleanRecord.scenes || [],
    statuses: cleanRecord.statuses || [],
    keywords: buildKeywords(cleanRecord),
    notes: cleanRecord.notes?.trim() || "",
    width,
    height,
    aspectRatio: width && height ? Number((width / height).toFixed(4)) : 0,
    originalSizeKB: cleanRecord.originalSizeKB || 0,
    optimizedSizeKB,
    imageFileID: cleanRecord.imageFileID || "",
    isVisible: cleanRecord.isVisible !== false,
    sortOrder: cleanRecord.sortOrder,
    needsReview: Boolean(cleanRecord.needsReview || optimizedSizeKB > SOFT_SIZE_LIMIT_KB)
  };
}

export function sanitizeRecord(record = {}) {
  const { crafts, ...rest } = record;
  return {
    ...rest,
    packageTypes: normalizeFieldValues("packageTypes", record.packageTypes),
    styles: normalizeFieldValues("styles", record.styles),
    priceLevel: normalizeFieldValue("priceLevel", record.priceLevel),
    scenes: normalizeFieldValues("scenes", record.scenes),
    statuses: normalizeFieldValues("statuses", record.statuses)
  };
}

function normalizeFieldValues(field, values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => normalizeFieldValue(field, value)).filter(Boolean))];
}

function normalizeFieldValue(field, value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (
    VALUE_MIGRATIONS[field] &&
    Object.prototype.hasOwnProperty.call(VALUE_MIGRATIONS[field], text)
  ) {
    return VALUE_MIGRATIONS[field][text];
  }
  return text;
}

export function summarizeRecords(records) {
  const total = records.length;
  const completed = records.filter((record) => !record.skipped && isComplete(record)).length;
  const skipped = records.filter((record) => record.skipped).length;
  const invalid = records.filter((record) => !record.skipped && !isComplete(record)).length;
  const needsReview = records.filter((record) => record.needsReview).length;
  return {
    total,
    completed,
    skipped,
    invalid,
    needsReview,
    remaining: Math.max(total - completed, 0)
  };
}

export function ensureUniqueIds(records) {
  const ids = new Set();
  for (const record of records) {
    if (ids.has(record.id)) return false;
    ids.add(record.id);
  }
  return true;
}
