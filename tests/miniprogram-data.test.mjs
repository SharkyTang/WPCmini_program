import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(
  __dirname,
  "../miniprogram/miniprogram/utils/caseData.js"
);
const source = readFileSync(modulePath, "utf8");
const sandbox = {
  module: { exports: {} },
  exports: {},
  console,
};
sandbox.exports = sandbox.module.exports;
vm.runInNewContext(source, sandbox, { filename: modulePath });

const {
  normalizeCaseRecord,
  filterCases,
  buildFallbackBanners,
  getSceneLabel,
  HOME_SECTION_VALUES,
  SCENE_VALUES,
} = sandbox.module.exports;

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

test("normalizes CloudBase CMS case records into display-ready fields", () => {
  const normalized = normalizeCaseRecord({
    _id: "abc",
    title: "测试酒包装案例",
    coverImage: "cloud://cover",
    wineType: "白酒",
    packageTypes: { values: ["礼盒", "瓶子"] },
    styles: ["国潮"],
    priceLevel: "低端",
    crafts: { values: ["烫金"] },
    scenes: null,
    statuses: { values: ["推荐"] },
    isVisible: true,
    sortOrder: "3",
  });

  assert.equal(normalized.id, "abc");
  assert.equal(normalized.coverImage, "cloud://cover");
  assert.deepEqual(plain(normalized.packageTypes), ["礼盒", "瓶子"]);
  assert.deepEqual(plain(normalized.styles), ["国风"]);
  assert.equal(normalized.priceLevel, "基础款");
  assert.deepEqual(plain(normalized.crafts), []);
  assert.deepEqual(plain(normalized.scenes), []);
  assert.deepEqual(plain(normalized.statuses), []);
  assert.deepEqual(plain(normalized.homeSections), [HOME_SECTION_VALUES.BANNER]);
  assert.equal(normalized.sortOrder, 3);
  assert.equal(normalized.searchText.includes("礼盒"), true);
  assert.equal(normalized.searchText.includes("国风"), true);
  assert.equal(normalized.searchText.includes("国潮"), false);
  assert.equal(normalized.searchText.includes("烫金"), false);
  assert.equal(normalized.tags.includes("烫金"), false);
});

test("keeps scene values stable while exposing the complete ordered label catalog", () => {
  assert.deepEqual(plain(SCENE_VALUES), [
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
  assert.equal(getSceneLabel("婚宴"), "婚宴/喜宴");
  assert.equal(getSceneLabel("送礼"), "送礼");
});

test("indexes the wedding display alias without rewriting legacy scene data", () => {
  const weddingCase = normalizeCaseRecord({
    _id: "wedding",
    title: "婚庆礼盒",
    scenes: { values: ["婚宴"] },
    isVisible: true,
  });

  assert.deepEqual(plain(weddingCase.scenes), ["婚宴"]);
  assert.deepEqual(
    plain(filterCases([weddingCase], { query: "喜宴" }).map((item) => item.id)),
    ["wedding"]
  );
  assert.deepEqual(
    plain(filterCases([weddingCase], { query: "婚宴/喜宴" }).map((item) => item.id)),
    ["wedding"]
  );
});

test("filters visible cases by text, single-value fields, and multi-value fields", () => {
  const cases = [
    normalizeCaseRecord({
      _id: "match",
      title: "国潮礼盒",
      wineType: "白酒",
      priceLevel: "高端",
      packageTypes: { values: ["礼盒"] },
      styles: { values: ["国潮"] },
      scenes: { values: ["送礼"] },
      statuses: { values: ["热门"] },
      isVisible: true,
    }),
    normalizeCaseRecord({
      _id: "hidden",
      title: "隐藏案例",
      wineType: "白酒",
      packageTypes: { values: ["礼盒"] },
      isVisible: false,
    }),
  ];

  const result = filterCases(cases, {
    query: "国风",
    selectedFilters: {
      packageTypes: ["礼盒"],
      styles: ["国风"],
      priceLevel: ["高端款"],
    },
  });

  assert.deepEqual(plain(result.map((item) => item.id)), ["match"]);
});

test("keeps legacy covers as a one-image gallery and pins only default sorting", () => {
  const legacy = normalizeCaseRecord({ _id: "legacy", coverImage: "cloud://legacy", isVisible: true });
  const cases = [
    normalizeCaseRecord({ _id: "normal", coverImage: "cloud://normal", sortOrder: 1, isVisible: true }),
    normalizeCaseRecord({ _id: "pinned", galleryImages: ["cloud://cover", "cloud://detail"], sortOrder: 9, isVisible: true, isPinned: true }),
  ];
  const sorted = filterCases(cases, { pinnedFirst: true });

  assert.deepEqual(plain(legacy.galleryImages), ["cloud://legacy"]);
  assert.equal(cases[1].coverImage, "cloud://cover");
  assert.deepEqual(plain(sorted.map((item) => item.id)), ["pinned", "normal"]);
  assert.deepEqual(plain(filterCases(cases).map((item) => item.id)), ["normal", "pinned"]);
});

test("client normalization preserves up to nine case images", () => {
  const galleryImages = Array.from(
    { length: 10 },
    (_, index) => `cloud://gallery-${index}`
  );
  const normalized = normalizeCaseRecord({
    _id: "nine-image-case",
    galleryImages,
    isVisible: true,
  });

  assert.equal(normalized.galleryImages.length, 9);
  assert.deepEqual(plain(normalized.galleryImages), galleryImages.slice(0, 9));
});

test("builds fallback banners from home section cases when CMS banners are empty", () => {
  const cases = [
    normalizeCaseRecord({
      _id: "case_1",
      title: "轮播案例",
      coverImage: "cloud://recommended",
      homeSections: { values: [HOME_SECTION_VALUES.BANNER] },
      isVisible: true,
      sortOrder: 2,
    }),
  ];

  const banners = buildFallbackBanners([], cases);

  assert.deepEqual(plain(banners), [
    {
      id: "case_1",
      title: "轮播案例",
      image: "cloud://recommended",
      caseId: "case_1",
      sortOrder: 2,
    },
  ]);
});
