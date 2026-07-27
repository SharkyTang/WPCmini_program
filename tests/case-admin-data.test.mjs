import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadCommonJsModule(modulePath, dependencies = {}) {
  const source = readFileSync(modulePath, "utf8");
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require(moduleName) {
      if (dependencies[moduleName]) return dependencies[moduleName];
      throw new Error(`Unexpected require: ${moduleName}`);
    },
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(source, sandbox, { filename: modulePath });
  return sandbox.module.exports;
}

const caseDataPath = resolve(__dirname, "../miniprogram/miniprogram/utils/caseData.js");
const caseData = loadCommonJsModule(caseDataPath);
const caseAdminDataPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/utils/caseAdminData.js"
);
const caseAdminEditWxmlPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/case-admin/edit.wxml"
);
const caseAdminData = loadCommonJsModule(caseAdminDataPath, {
  "./caseData": caseData,
});

const {
  CASE_ADMIN_FORM_OPTIONS,
  buildCaseAdminPayload,
  buildCaseAdminOptionViews,
  buildCaseKeywords,
  createEmptyCaseForm,
  isCloudFileId,
  normalizeCaseAdminForm,
  normalizeCaseAdminHomepageDisplayItem,
  validateCaseAdminForm,
} = caseAdminData;

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("creates hidden empty case form defaults", () => {
  const form = createEmptyCaseForm();

  assert.equal(form.wineType, "白酒");
  assert.equal(form.isVisible, false);
  assert.equal(form.sortOrder, "");
  assert.deepEqual(plain(form.packageTypes), []);
  assert.deepEqual(plain(form.statuses), []);
  assert.deepEqual(plain(form.homeSections), []);
  assert.deepEqual(plain(form.galleryImages), []);
  assert.equal(form.isPinned, false);
});

test("exposes case admin form options by field key", () => {
  assert.deepEqual(plain(CASE_ADMIN_FORM_OPTIONS.packageTypes.options), [
    "整套包装",
    "瓶标",
    "瓶子",
    "礼盒",
    "桶盒",
    "卡盒",
    "手提袋",
    "外箱",
  ]);
  assert.ok(CASE_ADMIN_FORM_OPTIONS.styles.options.includes("国风"));
  assert.ok(CASE_ADMIN_FORM_OPTIONS.priceLevel.options.includes("品质款"));
  assert.ok(CASE_ADMIN_FORM_OPTIONS.scenes.options.includes("送礼"));
  assert.deepEqual(plain(CASE_ADMIN_FORM_OPTIONS.statuses.options), ["热门产品", "最新产品"]);
  assert.equal(CASE_ADMIN_FORM_OPTIONS.statuses.options.includes("推荐"), false);
  assert.deepEqual(
    plain(CASE_ADMIN_FORM_OPTIONS.homeSections.options.map((option) => option.label)),
    ["首页轮播显示", "热门产品显示", "最新产品显示"]
  );
});

test("case admin edit form shows home section controls after visibility switch", () => {
  const wxml = readFileSync(caseAdminEditWxmlPath, "utf8");
  const visibleIndex = wxml.indexOf("前台显示");
  const homeSectionIndex = wxml.indexOf("首页展示位置");

  assert.notEqual(homeSectionIndex, -1);
  assert.equal(wxml.includes("首页轮播显示"), false);
  assert.ok(homeSectionIndex > visibleIndex);
  assert.equal(wxml.includes("optionViews.homeSections"), true);
  assert.equal(wxml.includes("不勾选仍可在分类页显示"), true);
});

test("builds selected option view models for case admin form chips", () => {
  const optionViews = buildCaseAdminOptionViews({
    packageTypes: ["礼盒"],
    styles: ["国风"],
    priceLevel: "品质款",
    scenes: ["送礼"],
    statuses: ["热门产品"],
    homeSections: ["popular"],
  });

  const findOption = (group, value) =>
    optionViews[group].find((option) => option.value === value);

  assert.equal(findOption("packageTypes", "礼盒").selected, true);
  assert.equal(findOption("packageTypes", "瓶标").selected, false);
  assert.equal(findOption("styles", "国风").selected, true);
  assert.equal(findOption("priceLevel", "品质款").selected, true);
  assert.equal(findOption("scenes", "送礼").selected, true);
  assert.equal(findOption("statuses", "热门产品").selected, true);
  assert.equal(findOption("homeSections", "popular").selected, true);
  assert.equal(findOption("homeSections", "popular").label, "热门产品显示");
});

test("keeps the database document id for editable homepage cases", () => {
  const item = normalizeCaseAdminHomepageDisplayItem({
    id: "db_document_030",
    caseId: "case_030",
    title: "首页轮播案例",
    coverImage: "cloud://cloud1/case-030.jpg",
    source: "case",
    displayLabel: "首页轮播",
    displayOrder: 1,
  });

  assert.equal(item.id, "db_document_030");
  assert.equal(item.caseId, "case_030");
  assert.equal(item.displayKey, "case:db_document_030");
});

test("validates required title cover image and package types", () => {
  const result = validateCaseAdminForm(
    {
      title: "",
      coverImage: "",
      packageTypes: [],
    },
    { isCreate: true }
  );

  assert.equal(result.valid, false);
  assert.equal(result.message, "请填写案例标题");
});

test("rejects non cloud cover image ids", () => {
  const result = validateCaseAdminForm(
    {
      title: "青花礼盒",
      coverImage: "/tmp/local.jpg",
      packageTypes: ["礼盒"],
    },
    { isCreate: true }
  );

  assert.equal(isCloudFileId("cloud://cloud1/image.jpg"), true);
  assert.equal(isCloudFileId("/tmp/local.jpg"), false);
  assert.equal(result.valid, false);
  assert.equal(result.message, "封面图片需要先上传到云存储");
});

test("normalizes case admin form and builds keywords", () => {
  const form = normalizeCaseAdminForm({
    title: "  青花礼盒  ",
    caseId: " case_new ",
    coverImage: "cloud://cloud1/file.jpg",
    galleryImages: ["cloud://cloud1/file.jpg", "cloud://cloud1/detail.jpg"],
    wineType: "",
    packageTypes: ["礼盒", "礼盒", ""],
    styles: ["国风"],
    priceLevel: "品质款",
    scenes: ["送礼"],
    statuses: ["最新产品"],
    homeSections: ["latest"],
    sortOrder: "8",
    notes: "  备注  ",
    isVisible: true,
    isPinned: true,
  });
  const keywords = buildCaseKeywords(form);

  assert.equal(form.title, "青花礼盒");
  assert.equal(form.wineType, "白酒");
  assert.deepEqual(plain(form.packageTypes), ["礼盒"]);
  assert.equal(form.sortOrder, 8);
  assert.deepEqual(plain(form.galleryImages), ["cloud://cloud1/file.jpg", "cloud://cloud1/detail.jpg"]);
  assert.equal(form.coverImage, "cloud://cloud1/file.jpg");
  assert.equal(form.isPinned, true);
  assert.deepEqual(plain(keywords.values), [
    "青花礼盒",
    "case_new",
    "白酒",
    "礼盒",
    "国风",
    "品质款",
    "送礼",
    "最新产品",
  ]);
});

test("rejects galleries with more than five images", () => {
  const result = validateCaseAdminForm({
    title: "多图案例",
    galleryImages: Array.from({ length: 6 }, (_, index) => `cloud://cloud1/${index}.jpg`),
    packageTypes: ["礼盒"],
  }, { isCreate: true });

  assert.equal(result.valid, false);
  assert.equal(result.message, "最多上传 5 张图片");
});

test("builds database payload with json value fields and leaves blank sort order for cloud default", () => {
  const payload = buildCaseAdminPayload({
    title: "测试案例",
    coverImage: "cloud://cloud1/file.jpg",
    packageTypes: ["整套包装"],
    sortOrder: "",
  });

  assert.equal(payload.title, "测试案例");
  assert.equal(payload.isVisible, false);
  assert.equal(payload.sortOrder, "");
  assert.deepEqual(plain(payload.packageTypes), { values: ["整套包装"] });
  assert.deepEqual(plain(payload.homeSections), { values: [] });
  assert.deepEqual(plain(payload.keywords.values), ["测试案例", "白酒", "整套包装"]);
});
