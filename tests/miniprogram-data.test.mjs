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
    scenes: null,
    statuses: { values: ["推荐"] },
    isVisible: true,
    sortOrder: "3",
  });

  assert.equal(normalized.id, "abc");
  assert.equal(normalized.coverImage, "cloud://cover");
  assert.deepEqual(plain(normalized.packageTypes), ["礼盒", "瓶子"]);
  assert.deepEqual(plain(normalized.styles), ["国潮"]);
  assert.deepEqual(plain(normalized.scenes), []);
  assert.deepEqual(plain(normalized.statuses), ["推荐"]);
  assert.equal(normalized.sortOrder, 3);
  assert.equal(normalized.searchText.includes("礼盒"), true);
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
      statuses: { values: ["推荐"] },
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
    query: "国潮",
    selectedFilters: {
      packageTypes: ["礼盒"],
      styles: ["国潮"],
      priceLevel: ["高端"],
    },
  });

  assert.deepEqual(plain(result.map((item) => item.id)), ["match"]);
});

test("builds fallback banners from recommended cases when CMS banners are empty", () => {
  const cases = [
    normalizeCaseRecord({
      _id: "case_1",
      title: "推荐案例",
      coverImage: "cloud://recommended",
      statuses: { values: ["推荐"] },
      isVisible: true,
      sortOrder: 2,
    }),
  ];

  const banners = buildFallbackBanners([], cases);

  assert.deepEqual(plain(banners), [
    {
      id: "case_1",
      title: "推荐案例",
      image: "cloud://recommended",
      caseId: "case_1",
      sortOrder: 2,
    },
  ]);
});
