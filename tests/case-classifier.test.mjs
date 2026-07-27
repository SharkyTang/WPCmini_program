import assert from "node:assert/strict";
import {
  buildExportRecord,
  buildKeywords,
  CLASSIFICATION_CONFIG,
  createCaseId,
  createEmptyRecord,
  ensureUniqueIds,
  isSupportedImageFile,
  sanitizeRecord,
  setSingleValue,
  sortImageFiles,
  summarizeRecords,
  toggleMultiValue,
  validateRecord
} from "../classifierLogic.mjs";

const files = [
  { name: "10.png", type: "image/png", size: 2048, lastModified: 3 },
  { name: "2.jpeg", type: "image/jpeg", size: 1024, lastModified: 2 },
  { name: "notes.txt", type: "text/plain", size: 10, lastModified: 1 },
  { name: "1.jpg", type: "image/jpeg", size: 512, lastModified: 1 }
];

assert.equal(isSupportedImageFile(files[0]), true);
assert.equal(isSupportedImageFile(files[2]), false);
assert.deepEqual(sortImageFiles(files).map((file) => file.name), ["1.jpg", "2.jpeg", "10.png"]);

assert.equal(createCaseId(0), "case_001");
assert.equal(createCaseId(88), "case_089");

const record = createEmptyRecord({ name: "IMG_8237.png", size: 8_499_200, lastModified: 1 }, 0);
assert.equal(record.id, "case_001");
assert.equal(record.uploadFileName, "case_001.jpg");
assert.equal(record.originalFileName, "IMG_8237.png");
assert.equal(record.originalSizeKB, 8300);
assert.equal(record.wineType, "白酒");
assert.deepEqual(validateRecord(record), ["缺包装内容"]);
assert.equal(CLASSIFICATION_CONFIG.wineType.label, "酒类");
assert.equal(CLASSIFICATION_CONFIG.packageTypes.label, "包装");
assert.equal(CLASSIFICATION_CONFIG.priceLevel.label, "定位");
assert.equal(CLASSIFICATION_CONFIG.scenes.label, "场景");
assert.deepEqual(CLASSIFICATION_CONFIG.packageTypes.options, ["整套包装", "瓶标", "瓶子", "礼盒", "桶盒", "卡盒", "手提袋", "外箱"]);
assert.deepEqual(CLASSIFICATION_CONFIG.priceLevel.options, ["基础款", "品质款", "高端款", "珍藏款"]);
assert.deepEqual(CLASSIFICATION_CONFIG.styles.options, ["轻奢", "国风", "新中式", "复古", "简约", "商务", "时尚", "喜庆"]);
assert.equal(CLASSIFICATION_CONFIG.styles.options.includes("高端"), false);
assert.equal(CLASSIFICATION_CONFIG.styles.options.includes("国潮"), false);
assert.equal(Object.hasOwn(CLASSIFICATION_CONFIG, "crafts"), false);
assert.deepEqual(CLASSIFICATION_CONFIG.statuses.options, ["热门产品", "最新产品"]);
assert.equal(CLASSIFICATION_CONFIG.statuses.options.includes("推荐"), false);
assert.equal(CLASSIFICATION_CONFIG.statuses.options.includes("新上传"), false);

let minimalTagged = toggleMultiValue(record, "packageTypes", "礼盒");
assert.deepEqual(validateRecord(minimalTagged), []);

let tagged = { ...minimalTagged, title: "" };
tagged = toggleMultiValue(tagged, "packageTypes", "礼盒");
tagged = toggleMultiValue(tagged, "packageTypes", "瓶子");
tagged = toggleMultiValue(tagged, "packageTypes", "桶盒");
tagged = toggleMultiValue(tagged, "styles", "新中式");
tagged = toggleMultiValue(tagged, "scenes", "商务招待");
tagged = toggleMultiValue(tagged, "statuses", "新上传");
tagged = setSingleValue(tagged, "priceLevel", "低端");

assert.deepEqual(validateRecord(tagged), []);
assert.deepEqual(buildKeywords({ ...tagged, crafts: ["哑膜"] }), ["白酒", "瓶子", "桶盒", "新中式", "基础款", "商务招待", "最新产品"]);

const duplicateStyleRecord = { ...tagged, styles: ["年轻化", "时尚"] };
assert.deepEqual(sanitizeRecord(duplicateStyleRecord).styles, ["时尚"]);
assert.deepEqual(buildExportRecord(duplicateStyleRecord).styles, ["时尚"]);
assert.deepEqual(buildKeywords(duplicateStyleRecord), ["白酒", "瓶子", "桶盒", "时尚", "基础款", "商务招待", "最新产品"]);

const oldStyleRecord = { ...tagged, styles: ["传统", "节日", "年轻化", "国潮", "高端"] };
assert.deepEqual(sanitizeRecord(oldStyleRecord).styles, ["复古", "喜庆", "时尚", "国风", "轻奢"]);
assert.deepEqual(buildExportRecord(oldStyleRecord).styles, ["复古", "喜庆", "时尚", "国风", "轻奢"]);
const oldValueRecord = { ...tagged, priceLevel: "奢华", statuses: ["新上传"] };
assert.equal(sanitizeRecord(oldValueRecord).priceLevel, "珍藏款");
assert.deepEqual(sanitizeRecord(oldValueRecord).statuses, ["最新产品"]);
assert.equal(buildExportRecord(oldValueRecord).priceLevel, "珍藏款");
assert.deepEqual(buildExportRecord(oldValueRecord).statuses, ["最新产品"]);
assert.equal(sanitizeRecord({ ...tagged, priceLevel: "高端" }).priceLevel, "高端款");
assert.deepEqual(buildKeywords(oldValueRecord), ["白酒", "瓶子", "桶盒", "新中式", "珍藏款", "商务招待", "最新产品"]);
assert.equal(buildKeywords(oldStyleRecord).includes("传统"), false);
assert.equal(buildKeywords(oldStyleRecord).includes("节日"), false);
assert.equal(buildKeywords(oldStyleRecord).includes("年轻化"), false);
assert.equal(buildKeywords(oldStyleRecord).includes("国潮"), false);
assert.equal(buildKeywords(oldStyleRecord).includes("国风"), true);
assert.equal(buildKeywords(oldStyleRecord).includes("高端"), false);
assert.equal(buildKeywords(oldStyleRecord).includes("轻奢"), true);

const exported = buildExportRecord(tagged, { width: 1600, height: 1200, optimizedSizeKB: 650 });
assert.equal(exported.imageFileID, "");
assert.equal(exported.title, "");
assert.equal(exported.aspectRatio, 1.3333);
assert.equal(exported.needsReview, false);
assert.equal(exported.priceLevel, "基础款");
assert.deepEqual(exported.statuses, ["最新产品"]);
assert.deepEqual(exported.packageTypes, ["瓶子", "桶盒"]);
assert.equal(Object.hasOwn(exported, "crafts"), false);
assert.equal(Object.hasOwn(exported, "priceLevel"), true);
assert.equal(Object.hasOwn(exported, "packageTypes"), true);
assert.equal(Object.hasOwn(exported, "scenes"), true);
assert.equal(Object.hasOwn(exported, "statuses"), true);

const largeExported = buildExportRecord(tagged, { width: 2000, height: 1200, optimizedSizeKB: 1400 });
assert.equal(largeExported.needsReview, true);

assert.equal(ensureUniqueIds([record, { ...record, id: "case_002" }]), true);
assert.equal(ensureUniqueIds([record, { ...record }]), false);

assert.deepEqual(
  summarizeRecords([
    { ...tagged, completed: true },
    { ...record },
    { ...record, skipped: true, needsReview: true }
  ]),
  { total: 3, completed: 1, skipped: 1, invalid: 1, needsReview: 1, remaining: 2 }
);

console.log("case-classifier tests passed");
