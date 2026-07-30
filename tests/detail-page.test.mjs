import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wxmlPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/detail/index.wxml"
);
const jsonPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/detail/index.json"
);
const wxssPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/detail/index.wxss"
);
const pagePath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/detail/index.js"
);

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("detail page exposes one clear return action for unavailable cases", () => {
  const wxml = readFileSync(wxmlPath, "utf8");

  assert.equal(wxml.includes("返回继续筛选"), false);
  assert.equal(wxml.includes("返回案例库"), true);
});

test("detail consult action opens official customer service", () => {
  const wxml = readFileSync(wxmlPath, "utf8");
  const contactBranches = wxml.match(
    /<block wx:if="\{\{customerServiceMessageImage\}\}">([\s\S]*?)<\/block>\s*<block wx:else>([\s\S]*?)<\/block>/
  );
  assert.ok(contactBranches);
  const imageBranch = contactBranches[1];
  const fallbackBranch = contactBranches[2];
  [
    'open-type="contact"',
    'session-from="{{customerServiceSessionFrom}}"',
    'show-message-card="{{customerServiceMessageCardEnabled}}"',
    'send-message-title="{{customerServiceMessageTitle}}"',
    'send-message-path="{{customerServiceMessagePath}}"',
    'bindcontact="handleContact"',
  ].forEach((attribute) => {
    assert.equal(imageBranch.includes(attribute), true);
    assert.equal(fallbackBranch.includes(attribute), true);
  });
  assert.equal(
    imageBranch.includes('send-message-img="{{customerServiceMessageImage}}"'),
    true
  );
  assert.equal(fallbackBranch.includes("send-message-img"), false);
  assert.equal(wxml.includes('bindtap="showConsultTip"'), false);
});

test("detail page keeps customer service and adds inquiry action", () => {
  const wxml = readFileSync(wxmlPath, "utf8");

  assert.equal(wxml.includes("咨询同款包装方案"), true);
  assert.equal(wxml.includes("提交定制需求"), true);
  assert.equal(wxml.includes('bindtap="openInquiryForm"'), true);
});

test("detail page supports a gallery and downloads the selected image", () => {
  const wxml = readFileSync(wxmlPath, "utf8");
  const wxss = readFileSync(wxssPath, "utf8");
  const source = readFileSync(resolve(__dirname, "../miniprogram/miniprogram/pages/detail/index.js"), "utf8");

  assert.equal(wxml.includes('bindchange="onGalleryChange"'), true);
  assert.equal(wxml.includes('bindtap="selectGalleryImage"'), true);
  assert.match(
    wxml,
    /<scroll-view[\s\S]*?class="gallery-thumbnails"[\s\S]*?scroll-x[\s\S]*?show-scrollbar="\{\{false\}\}"/
  );
  assert.equal(wxml.includes('class="gallery-thumbnails-track"'), true);
  assert.match(wxss, /\.gallery-thumbnails-track\s*\{[\s\S]*?display:\s*inline-flex;/);
  assert.match(wxss, /\.gallery-thumbnail\s*\{[\s\S]*?flex:\s*0 0 104rpx;/);
  assert.equal(source.includes("currentImageUrl"), true);
  assert.equal(wxml.includes('src="{{item.renderUrl}}"'), true);
  assert.equal(source.includes("loaded: index === 0"), true);
  assert.equal(source.includes("renderUrl: item.displayUrl"), true);
});

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

await asyncTest("detail loads one display image and upgrades only the selected target", async () => {
  let page;
  const messageCardCalls = [];
  const gallery = Array.from({ length: 9 }, (_, index) => ({
    fileID: `cloud://env/display-${index}.jpg`,
    displayUrl: `https://temp/display-${index}`,
    thumbnailUrl: `https://temp/thumb-${index}`,
    downloadUrl: `https://temp/source-${index}`,
  }));
  let detailCase = {
    id: "case_1",
    title: "案例",
    packageTypes: [],
    styles: [],
    scenes: [],
    gallery,
  };
  const sandbox = {
    Page(config) {
      page = config;
    },
    console,
    require(moduleName) {
      if (moduleName === "../../utils/cloudData") {
        return { fetchCaseById: async () => ({}) };
      }
      if (moduleName === "../../utils/caseCatalogService") {
        return {
          fetchCaseDetail: async () => detailCase,
        };
      }
      if (moduleName === "../../utils/caseData") {
        return { formatJoined: (values, fallback = "") => (values || []).join("/") || fallback };
      }
      if (moduleName === "../../utils/customerServiceData") {
        return {
          CUSTOMER_SERVICE_SOURCE: { DETAIL: "detail" },
          buildCustomerMessageCard(options) {
            messageCardCalls.push(options);
            return {
              enabled: Boolean(options.caseItem.id),
              title: `咨询同款：${options.caseItem.title}`,
              path: `/pages/detail/index?id=${encodeURIComponent(options.caseItem.id)}`,
              imageUrl: options.imageUrl,
            };
          },
          buildCustomerSessionFrom: () => "",
        };
      }
      if (moduleName === "../../utils/favoriteService") {
        return {
          fetchFavoriteForCase: async () => null,
          toggleFavorite: async () => ({}),
        };
      }
      if (moduleName === "../../utils/historyService") {
        return { recordCaseView: async () => {} };
      }
      if (moduleName === "../../utils/userService") {
        return { ensureProfileIdentity: async () => ({ ready: false }) };
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    wx: {},
  };
  vm.runInNewContext(readFileSync(pagePath, "utf8"), sandbox, {
    filename: pagePath,
  });
  page.setData = function setData(patch) {
    this.data = { ...this.data, ...patch };
  };
  await page.loadCase("case_1");
  assert.equal(page.data.errorMessage, "");
  assert.equal(messageCardCalls.length, 1);
  assert.equal(messageCardCalls[0].caseItem.id, "case_1");
  assert.equal(messageCardCalls[0].imageUrl, "https://temp/display-0");
  assert.deepEqual(
    JSON.parse(JSON.stringify(page.data.galleryItems.map((item) => item.renderUrl))),
    Array.from(
      { length: 9 },
      (_, index) =>
        index === 0
          ? "https://temp/display-0"
          : `https://temp/thumb-${index}`
    )
  );
  assert.equal(page.data.customerServiceMessageCardEnabled, true);
  assert.equal(page.data.customerServiceMessageTitle, "咨询同款：案例");
  assert.equal(page.data.customerServiceMessagePath, "/pages/detail/index?id=case_1");
  assert.equal(page.data.customerServiceMessageImage, "https://temp/display-0");
  page.selectGalleryImage({ currentTarget: { dataset: { index: 7 } } });
  assert.equal(page.data.galleryItems[0].renderUrl, "https://temp/display-0");
  assert.equal(page.data.galleryItems[7].renderUrl, "https://temp/display-7");
  assert.equal(page.data.galleryItems[8].renderUrl, "https://temp/thumb-8");
  assert.equal(page.data.currentImageIndex, 7);
  assert.equal(page.data.currentDownloadUrl, "https://temp/display-7");
  assert.equal(page.data.customerServiceMessageImage, "https://temp/display-0");
  page.onGalleryChange({ detail: { current: 8 } });
  assert.equal(page.data.galleryItems[8].renderUrl, "https://temp/display-8");
  assert.equal(page.data.currentImageIndex, 8);
  assert.equal(page.data.currentDownloadUrl, "https://temp/display-8");
  assert.equal(page.data.customerServiceMessageImage, "https://temp/display-0");

  detailCase = {
    id: "case_without_cover",
    title: "无封面案例",
    packageTypes: [],
    styles: [],
    scenes: [],
    gallery: [],
    coverImageUrl: "",
  };
  await page.loadCase("case_without_cover");
  assert.equal(page.data.errorMessage, "");
  assert.equal(messageCardCalls.length, 2);
  assert.equal(messageCardCalls[1].imageUrl, "");
  assert.equal(page.data.customerServiceMessageCardEnabled, true);
  assert.equal(page.data.customerServiceMessageImage, "");
});

test("detail page uses branded states and removes developer-facing copy", () => {
  const wxml = readFileSync(wxmlPath, "utf8");
  const pageJson = JSON.parse(readFileSync(jsonPath, "utf8"));

  assert.equal(pageJson.usingComponents["mp-msg"], "weui-miniprogram/msg/msg");
  assert.equal(wxml.includes("<mp-msg"), true);
  assert.equal(wxml.includes("产品卡片点击后进入详情确认信息"), false);
  assert.equal(wxml.includes("image-count"), true);
  assert.equal(wxml.includes("案例信息"), true);
});

test("detail page removes the top copy and aligns its title with case information", () => {
  const wxml = readFileSync(wxmlPath, "utf8");
  const wxss = readFileSync(wxssPath, "utf8");

  assert.equal(wxml.includes("hero-copy"), false);
  assert.equal(wxml.includes("CASE INFORMATION"), false);
  assert.equal(wxml.includes("info-card-head"), true);
  assert.equal(wxml.includes("{{caseItem.title}}"), true);
  assert.match(
    wxss,
    /\.info-card-head\s*\{[\s\S]*?grid-template-columns:\s*150rpx minmax\(0,\s*1fr\);/
  );
  assert.match(wxss, /\.info-case-title\s*\{[\s\S]*?text-align:\s*left;/);
  assert.match(wxss, /\.consult-button,\s*\.inquiry-button\s*\{[\s\S]*?min-height:\s*100rpx;/);
  assert.match(
    wxss,
    /\.consult-contact-button\s*\{[\s\S]*?min-width:\s*100%;[\s\S]*?max-width:\s*100%;/
  );
});
