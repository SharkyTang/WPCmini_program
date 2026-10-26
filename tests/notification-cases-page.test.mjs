import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pagePath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/notification-cases/index.js"
);
const wxmlPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/notification-cases/index.wxml"
);
const editWxmlPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/notification-admin/edit.wxml"
);

function loadPage(options = {}) {
  let page;
  const calls = { toasts: [], navigations: [] };
  const sandbox = {
    Page(config) {
      page = config;
    },
    require(moduleName) {
      if (moduleName === "./utils/caseAdminService") {
        return {
          fetchRecentCaseAdminList: async () => ({
            items: options.recentItems || [],
            page: 1,
            hasMore: false,
          }),
        };
      }
      if (moduleName === "./utils/notificationAdminService") {
        return {
          fetchPublishedLinkedCases: async () => ({
            announcement: { title: "产品上新" },
            items: options.publishedItems || [],
            unavailableCount: 0,
          }),
        };
      }
      if (moduleName === "../../utils/caseData") {
        return {
          normalizeCaseRecord: (item) => ({
            ...item,
            id: item._id,
            tags: item.tags || [],
            scenes: item.scenes || [],
          }),
          getSceneLabel: (value) => (value === "婚宴" ? "婚宴/喜宴" : value),
        };
      }
      if (moduleName === "../../utils/cloudData") {
        return { attachCaseImageUrls: async (items) => items };
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    console,
    wx: {
      showToast(options) {
        calls.toasts.push(options);
      },
      navigateTo(options) {
        calls.navigations.push(options.url);
      },
      navigateBack() {},
      switchTab() {},
      setNavigationBarTitle() {},
    },
  };
  vm.runInNewContext(readFileSync(pagePath, "utf8"), sandbox, {
    filename: pagePath,
  });
  page.setData = function setData(nextData) {
    this.data = { ...this.data, ...nextData };
  };
  return { page, calls };
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

await test("notification case selector replaces manual document id input", () => {
  const editWxml = readFileSync(editWxmlPath, "utf8");
  const pageWxml = readFileSync(wxmlPath, "utf8");
  assert.equal(editWxml.includes("关联案例文档 ID"), false);
  assert.equal(editWxml.includes("选择近24小时新增案例"), true);
  assert.equal(editWxml.includes('lazy-load="{{true}}"'), true);
  assert.equal(pageWxml.includes("完成选择"), true);
  assert.equal(pageWxml.includes("全选已加载"), true);
});

await test("selector prevents selecting a twenty-first case", () => {
  const { page, calls } = loadPage();
  const cards = Array.from({ length: 21 }, (_, index) => ({
    id: `case_${index + 1}`,
    title: `案例 ${index + 1}`,
  }));
  page.setData({
    mode: "select",
    selectMode: true,
    cards,
    selectedCaseIds: cards.slice(0, 20).map((item) => item.id),
    selectedItems: cards.slice(0, 20),
  });
  page.toggleCaseSelection("case_21");
  assert.equal(page.data.selectedCaseIds.length, 20);
  assert.equal(calls.toasts.at(-1).title, "最多选择 20 个案例");
});

await test("view mode opens the selected case detail", () => {
  const { page, calls } = loadPage();
  page.setData({ mode: "view" });
  page.handleCardTap({ currentTarget: { dataset: { id: "case_doc_1" } } });
  assert.deepEqual(calls.navigations, ["/pages/detail/index?id=case_doc_1"]);
});

await test("notification case cards display the wedding alias", async () => {
  const { page } = loadPage({
    publishedItems: [
      {
        _id: "wedding_case",
        title: "喜宴礼盒",
        tags: ["婚宴"],
        scenes: ["婚宴"],
      },
    ],
  });

  await page.loadPublishedCases("announcement_1");
  assert.equal(page.data.cards[0].tagSummary, "婚宴/喜宴");
  assert.equal(page.data.cards[0].sceneSummary, "婚宴/喜宴");
  assert.deepEqual(
    JSON.parse(JSON.stringify(page.data.cards[0].scenes)),
    ["婚宴"]
  );
});
