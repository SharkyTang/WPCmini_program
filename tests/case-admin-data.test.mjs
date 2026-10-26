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
  "../miniprogram/miniprogram/pages/case-admin/utils/caseAdminData.js"
);
const caseAdminEditWxmlPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/case-admin/edit.wxml"
);
const caseAdminEditJsonPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/case-admin/edit.json"
);
const appJsonPath = resolve(__dirname, "../miniprogram/miniprogram/app.json");
const caseAdminData = loadCommonJsModule(caseAdminDataPath, {
  "../../../utils/caseData": caseData,
});
const notificationCaseAdminDataPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/notification-cases/utils/caseAdminData.js"
);
const notificationCaseAdminData = loadCommonJsModule(notificationCaseAdminDataPath, {
  "../../../utils/caseData": caseData,
});

const {
  CASE_ADMIN_GALLERY_MAX,
  CASE_ADMIN_VIDEO_DEFAULT_LIMITS,
  CASE_ADMIN_FORM_OPTIONS,
  buildCaseAdminPayload,
  buildCaseAdminOptionViews,
  buildCaseAdminVideoPatch,
  buildCaseKeywords,
  createEmptyCaseForm,
  isCloudFileId,
  normalizeCaseAdminItem,
  normalizeCaseAdminForm,
  normalizeCaseAdminHomepageDisplayItem,
  validateCaseAdminVideoPosterSelection,
  validateCaseAdminVideoSelection,
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
  assert.deepEqual(plain(form.scenes), []);
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
  assert.deepEqual(plain(CASE_ADMIN_FORM_OPTIONS.scenes.options), [
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
    "电商展示",
  ]);
  assert.deepEqual(plain(CASE_ADMIN_FORM_OPTIONS.statuses.options), ["热门产品", "最新产品"]);
  assert.equal(CASE_ADMIN_FORM_OPTIONS.statuses.options.includes("推荐"), false);
  assert.deepEqual(
    plain(CASE_ADMIN_FORM_OPTIONS.homeSections.options.map((option) => option.label)),
    ["首页轮播显示", "热门产品显示", "最新产品显示"]
  );
});

test("case admin edit form shows home section controls after visibility switch", () => {
  const wxml = readFileSync(caseAdminEditWxmlPath, "utf8");
  const pageJson = JSON.parse(readFileSync(caseAdminEditJsonPath, "utf8"));
  const appJson = JSON.parse(readFileSync(appJsonPath, "utf8"));
  const visibleIndex = wxml.indexOf("前台显示");
  const homeSectionIndex = wxml.indexOf("首页展示位置");

  assert.equal(appJson.useExtendedLib.weui, true);
  assert.equal(pageJson.usingComponents["mp-toptips"], "weui-miniprogram/toptips/toptips");
  assert.equal(wxml.includes("<mp-toptips"), true);
  assert.equal(wxml.includes("基础信息"), true);
  assert.equal(wxml.includes("分类标签"), true);
  assert.equal(wxml.includes("展示设置"), true);
  assert.notEqual(homeSectionIndex, -1);
  assert.equal(wxml.includes("首页轮播显示"), false);
  assert.ok(homeSectionIndex > visibleIndex);
  assert.equal(wxml.includes("optionViews.homeSections"), true);
  assert.equal(wxml.includes("不勾选仍可在分类页显示"), true);
  assert.equal(wxml.includes("最多 {{galleryMax}} 张"), true);
  assert.equal(wxml.includes("轮播最多 5 张、热门最多 4 个、最新最多 6 个"), true);
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

test("case admin scene chips use display labels and save internal values", () => {
  const optionViews = buildCaseAdminOptionViews({ scenes: ["婚宴"] });
  const wedding = optionViews.scenes.find((option) => option.value === "婚宴");
  const payload = buildCaseAdminPayload({
    title: "喜宴礼盒",
    coverImage: "cloud://cloud1/file.jpg",
    packageTypes: ["礼盒"],
    scenes: ["婚宴"],
  });

  assert.deepEqual(plain(wedding), {
    value: "婚宴",
    label: "婚宴/喜宴",
    selected: true,
  });
  assert.deepEqual(plain(payload.scenes), { values: ["婚宴"] });
  assert.equal(payload.keywords.values.includes("婚宴"), true);
  assert.equal(payload.keywords.values.includes("婚宴/喜宴"), false);
});

test("notification case admin duplicate uses the same scene catalog and labels", () => {
  assert.deepEqual(
    plain(notificationCaseAdminData.CASE_ADMIN_FORM_OPTIONS.scenes.options),
    plain(CASE_ADMIN_FORM_OPTIONS.scenes.options)
  );
  const wedding = notificationCaseAdminData
    .buildCaseAdminOptionViews({ scenes: ["婚宴"] })
    .scenes.find((option) => option.value === "婚宴");
  assert.equal(wedding.label, "婚宴/喜宴");
  assert.equal(wedding.value, "婚宴");
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

test("accepts nine case images and rejects the tenth", () => {
  const galleryImages = Array.from(
    { length: CASE_ADMIN_GALLERY_MAX },
    (_, index) => `cloud://cloud1/${index}.jpg`
  );
  const accepted = validateCaseAdminForm({
    title: "多图案例",
    galleryImages,
    packageTypes: ["礼盒"],
    sortOrder: "",
  }, { isCreate: true });
  const rejected = validateCaseAdminForm({
    title: "图片过多案例",
    galleryImages: [...galleryImages, "cloud://cloud1/9.jpg"],
    packageTypes: ["礼盒"],
    sortOrder: "",
  }, { isCreate: true });

  assert.equal(CASE_ADMIN_GALLERY_MAX, 9);
  assert.equal(accepted.valid, true);
  assert.equal(rejected.valid, false);
  assert.equal(rejected.message, "最多上传 9 张图片");
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

test("accepts the exact mobile video limits and rounds duration up", () => {
  const result = validateCaseAdminVideoSelection(
    {
      tempFilePath: "/tmp/case-video.mp4",
      size: 100 * 1024 * 1024,
      mimeType: "video/mp4",
    },
    { duration: 119.2, width: 1920, height: 1080 },
    CASE_ADMIN_VIDEO_DEFAULT_LIMITS
  );

  assert.equal(result.valid, true);
  assert.equal(result.data.durationSeconds, 120);
  assert.equal(result.data.size, 104857600);
});

test("rejects oversized, overlong, non-MP4, wrong MIME and 4K videos", () => {
  const validFile = {
    tempFilePath: "/tmp/case-video.mp4",
    size: 104857600,
    mimeType: "video/mp4",
  };
  const validMetadata = { duration: 120, width: 1080, height: 1920 };

  assert.equal(
    validateCaseAdminVideoSelection(
      { ...validFile, size: 104857601 },
      validMetadata
    ).message,
    "视频不能超过 100MB"
  );
  assert.equal(
    validateCaseAdminVideoSelection(validFile, {
      ...validMetadata,
      duration: 120.01,
    }).message,
    "视频不能超过 120 秒"
  );
  assert.equal(
    validateCaseAdminVideoSelection(
      { ...validFile, tempFilePath: "/tmp/case-video.mov" },
      validMetadata
    ).message,
    "请选择 MP4 格式的视频"
  );
  assert.equal(
    validateCaseAdminVideoSelection(
      { ...validFile, mimeType: "video/quicktime" },
      validMetadata
    ).message,
    "视频文件类型必须为 MP4"
  );
  assert.equal(
    validateCaseAdminVideoSelection(validFile, {
      ...validMetadata,
      width: 3840,
      height: 2160,
    }).message,
    "视频分辨率不能超过 1080p"
  );
});

test("validates optional poster type and five megabyte limit", () => {
  const accepted = validateCaseAdminVideoPosterSelection({
    tempFilePath: "/tmp/poster.webp",
    size: 5 * 1024 * 1024,
    mimeType: "image/webp",
  });
  const oversized = validateCaseAdminVideoPosterSelection({
    tempFilePath: "/tmp/poster.png",
    size: 5 * 1024 * 1024 + 1,
    mimeType: "image/png",
  });

  assert.equal(accepted.valid, true);
  assert.equal(oversized.valid, false);
  assert.equal(oversized.message, "视频封面不能超过 5MB");
});

test("builds atomic upload, external and clear video patches only when dirty", () => {
  const unchanged = buildCaseAdminVideoPatch({ dirty: false });
  const upload = buildCaseAdminVideoPatch({
    dirty: true,
    source: "upload",
    draft: {
      uploadFileID: "cloud://env/wine-packaging/videos/video.mp4",
      uploadDurationSeconds: 62,
      uploadPosterFileID: "cloud://env/wine-packaging/videos/poster.webp",
    },
  });
  const external = buildCaseAdminVideoPatch({
    dirty: true,
    source: "external",
    draft: {
      externalUrl: "https://cdn.example.com/video.mp4",
      externalPosterUrl: "https://cdn.example.com/poster.jpg",
      externalDurationSeconds: "88",
    },
  });
  const cleared = buildCaseAdminVideoPatch({ dirty: true, removed: true });

  assert.equal(unchanged.patch, null);
  assert.deepEqual(plain(upload.patch), {
    mode: "upload",
    fileID: "cloud://env/wine-packaging/videos/video.mp4",
    durationSeconds: 62,
    posterFileID: "cloud://env/wine-packaging/videos/poster.webp",
  });
  assert.deepEqual(plain(external.patch), {
    mode: "external",
    url: "https://cdn.example.com/video.mp4",
    durationSeconds: 88,
    posterUrl: "https://cdn.example.com/poster.jpg",
  });
  assert.deepEqual(plain(cleared.patch), { mode: "clear" });
});

test("normalizes legacy cases without a version to the backend version baseline", () => {
  assert.equal(normalizeCaseAdminItem({ _id: "legacy" }).version, 1);
  assert.equal(normalizeCaseAdminItem({ _id: "current", version: "7" }).version, 7);
  assert.equal(normalizeCaseAdminItem({ _id: "invalid", version: 0 }).version, 1);
});
