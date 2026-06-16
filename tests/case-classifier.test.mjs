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
assert.deepEqual(CLASSIFICATION_CONFIG.packageTypes.options, ["整套包装", "瓶标", "瓶子", "礼盒", "桶盒", "卡盒", "手提袋", "外箱"]);

let minimalTagged = toggleMultiValue(record, "packageTypes", "礼盒");
assert.deepEqual(validateRecord(minimalTagged), []);

let tagged = { ...minimalTagged, title: "" };
tagged = toggleMultiValue(tagged, "packageTypes", "礼盒");
tagged = toggleMultiValue(tagged, "packageTypes", "瓶子");
tagged = toggleMultiValue(tagged, "packageTypes", "桶盒");
tagged = toggleMultiValue(tagged, "styles", "新中式");
tagged = toggleMultiValue(tagged, "crafts", "哑膜");
tagged = toggleMultiValue(tagged, "scenes", "商务招待");
tagged = toggleMultiValue(tagged, "statuses", "新上传");
tagged = setSingleValue(tagged, "priceLevel", "低端");

assert.deepEqual(validateRecord(tagged), []);
assert.deepEqual(buildKeywords(tagged), ["白酒", "瓶子", "桶盒", "新中式", "低端", "哑膜", "商务招待", "新上传"]);

const duplicateStyleRecord = { ...tagged, styles: ["年轻化", "时尚"] };
assert.deepEqual(sanitizeRecord(duplicateStyleRecord).styles, ["时尚"]);
assert.deepEqual(buildExportRecord(duplicateStyleRecord).styles, ["时尚"]);
assert.deepEqual(buildKeywords(duplicateStyleRecord), ["白酒", "瓶子", "桶盒", "时尚", "低端", "哑膜", "商务招待", "新上传"]);

const oldStyleRecord = { ...tagged, styles: ["传统", "节日", "年轻化"] };
assert.deepEqual(sanitizeRecord(oldStyleRecord).styles, ["复古", "喜庆", "时尚"]);
assert.deepEqual(buildExportRecord(oldStyleRecord).styles, ["复古", "喜庆", "时尚"]);
assert.equal(buildKeywords(oldStyleRecord).includes("传统"), false);
assert.equal(buildKeywords(oldStyleRecord).includes("节日"), false);
assert.equal(buildKeywords(oldStyleRecord).includes("年轻化"), false);

const exported = buildExportRecord(tagged, { width: 1600, height: 1200, optimizedSizeKB: 650 });
assert.equal(exported.imageFileID, "");
assert.equal(exported.title, "");
assert.equal(exported.aspectRatio, 1.3333);
assert.equal(exported.needsReview, false);
assert.deepEqual(exported.packageTypes, ["瓶子", "桶盒"]);

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
