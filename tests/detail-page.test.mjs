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
  const source = readFileSync(pagePath, "utf8");

  assert.equal(wxml.includes("返回继续筛选"), false);
  assert.equal(wxml.includes("返回案例库"), true);
  assert.equal(wxml.includes('type="waiting"'), false);
  assert.equal(wxml.includes("正在读取案例"), false);
  assert.equal(source.includes("wx.showLoading"), true);
  assert.match(source, /title:\s*"加载中",\s*\n\s*mask:\s*true/);
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

test("detail page supports a gallery and native image preview", () => {
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
  assert.equal(wxml.includes('bindtap="previewImage"'), true);
  assert.equal(source.includes("loaded: index === 0"), true);
  assert.equal(source.includes("renderUrl: item.displayUrl"), true);
  assert.equal(source.includes("wx.previewImage"), true);
  assert.equal(source.includes("showmenu: true"), true);
  assert.equal(wxml.includes("image-preview-close"), false);
  assert.equal(wxml.includes("image-preview-download"), false);
  assert.equal(wxml.includes("icon-download.png"), false);
  assert.equal(wxml.includes("<movable-area"), false);
  assert.equal(source.includes("imagePreviewVisible"), false);
  assert.equal(source.includes("currentDownloadUrl"), false);
  assert.equal(source.includes("downloadImage()"), false);
  assert.equal(source.includes("wx.downloadFile"), false);
  assert.equal(source.includes("wx.saveImageToPhotosAlbum"), false);
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

function loadDetailInteractionPage(options = {}) {
  let page;
  const accessRequests = [];
  const resumeSources = [];
  const toasts = [];
  const nativeLoadingEvents = [];
  const previewCalls = [];
  const caseItem = options.caseItem || {
    id: "case_1",
    title: "鎏金礼盒",
    packageTypes: [],
    styles: [],
    scenes: [],
  };
  const sandbox = {
    Page(config) {
      page = config;
    },
    console: {
      error() {},
      log() {},
      warn() {},
    },
    require(moduleName) {
      if (moduleName === "../../utils/cloudData") {
        return {
          fetchCaseById: options.fetchCaseById || (async () => caseItem),
        };
      }
      if (moduleName === "../../utils/caseCatalogService") {
        return {
          fetchCaseDetail: options.fetchCaseDetail || (async () => caseItem),
        };
      }
      if (moduleName === "../../utils/caseData") {
        return {
          formatJoined: (values, fallback = "") =>
            (Array.isArray(values) ? values : [values]).filter(Boolean).join("/") || fallback,
        };
      }
      if (moduleName === "../../utils/customerServiceData") {
        return {
          CUSTOMER_SERVICE_SOURCE: { DETAIL: "detail" },
          buildCustomerMessageCard: () => ({
            enabled: false,
            title: "",
            path: "",
            imageUrl: "",
          }),
          buildCustomerSessionFrom: () => "",
        };
      }
      if (moduleName === "../../utils/favoriteService") {
        return {
          fetchFavoriteForCase: async () => null,
          toggleFavorite:
            options.toggleFavorite ||
            (async () => ({
              action: "added",
              favorite: { _id: "favorite_1" },
              isFavorited: true,
            })),
        };
      }
      if (moduleName === "../../utils/historyService") {
        return { recordCaseView: async () => {} };
      }
      if (moduleName === "../../utils/libraryAccessService") {
        return {
          async requestLibraryAccess(request) {
            accessRequests.push(request);
            if (options.requestLibraryAccess) {
              return options.requestLibraryAccess(request);
            }
            return { status: "ready" };
          },
          async resumePendingLibraryAction(source) {
            resumeSources.push(source);
            if (options.resumePendingLibraryAction) {
              return options.resumePendingLibraryAction(source);
            }
            return false;
          },
        };
      }
      if (moduleName === "../../utils/userService") {
        return {
          resumePendingProfileAction:
            options.resumePendingProfileAction ||
            (async () => false),
        };
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    wx: {
      showLoading(payload) {
        nativeLoadingEvents.push({ type: "show", payload });
      },
      hideLoading() {
        nativeLoadingEvents.push({ type: "hide" });
      },
      showToast(payload) {
        toasts.push(payload);
      },
      previewImage(payload) {
        previewCalls.push(payload);
      },
    },
  };

  vm.runInNewContext(readFileSync(pagePath, "utf8"), sandbox, {
    filename: pagePath,
  });
  page.setData = function setData(patch) {
    this.data = { ...this.data, ...patch };
  };
  page.setData({
    caseItem,
    favorite: options.favorite || null,
    isFavorited: Boolean(options.favorite),
    favoriteLoading: false,
  });
  return {
    page,
    accessRequests,
    resumeSources,
    toasts,
    nativeLoadingEvents,
    previewCalls,
  };
}

test("detail image tap opens the selected image in the native gallery", () => {
  const { page, previewCalls, toasts } = loadDetailInteractionPage();
  page.setData({
    galleryItems: [
      { displayUrl: "https://temp/display-1" },
      { displayUrl: "https://temp/display-2" },
    ],
    currentImageUrl: "https://temp/display-2",
  });

  page.previewImage();

  assert.equal(previewCalls.length, 1);
  assert.equal(previewCalls[0].current, "https://temp/display-2");
  assert.deepEqual(
    JSON.parse(JSON.stringify(previewCalls[0].urls)),
    ["https://temp/display-1", "https://temp/display-2"]
  );
  assert.equal(previewCalls[0].showmenu, true);
  assert.equal(typeof previewCalls[0].fail, "function");

  previewCalls[0].fail(new Error("preview failed"));
  assert.deepEqual(
    JSON.parse(JSON.stringify(toasts.at(-1))),
    {
      title: "图片预览失败",
      icon: "none",
    }
  );

  page.setData({
    galleryItems: [],
    currentImageUrl: "",
  });
  page.previewImage();
  assert.equal(previewCalls.length, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(toasts.at(-1))),
    {
      title: "暂无图片",
      icon: "none",
    }
  );
});

await asyncTest("detail case reads use the native loading overlay on success and failure", async () => {
  const success = loadDetailInteractionPage();

  assert.equal(await success.page.loadCase("case_1"), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(success.nativeLoadingEvents)),
    [
      { type: "show", payload: { title: "加载中", mask: true } },
      { type: "hide" },
    ]
  );

  const failure = loadDetailInteractionPage({
    fetchCaseDetail: async () => {
      throw new Error("catalog unavailable");
    },
    fetchCaseById: async () => {
      throw new Error("detail unavailable");
    },
  });

  assert.equal(await failure.page.loadCase("case_2"), false);
  assert.equal(failure.page.data.loading, false);
  assert.match(failure.page.data.errorMessage, /暂时读取不到/);
  assert.deepEqual(
    JSON.parse(JSON.stringify(failure.nativeLoadingEvents)),
    [
      { type: "show", payload: { title: "加载中", mask: true } },
      { type: "hide" },
    ]
  );
});

await asyncTest("detail case loading ignores stale requests and cleans up on unload", async () => {
  const pending = new Map();
  const context = loadDetailInteractionPage({
    fetchCaseDetail: (id) =>
      new Promise((resolveRequest) => {
        pending.set(id, resolveRequest);
      }),
  });
  const buildCase = (id) => ({
    id,
    title: id,
    packageTypes: [],
    styles: [],
    scenes: [],
  });

  const firstLoad = context.page.loadCase("old_case");
  const secondLoad = context.page.loadCase("new_case");
  pending.get("new_case")(buildCase("new_case"));
  assert.equal(await secondLoad, true);
  assert.equal(context.page.data.caseItem.id, "new_case");
  assert.equal(
    context.nativeLoadingEvents.filter((event) => event.type === "hide").length,
    1
  );

  pending.get("old_case")(buildCase("old_case"));
  assert.equal(await firstLoad, false);
  assert.equal(context.page.data.caseItem.id, "new_case");
  assert.equal(
    context.nativeLoadingEvents.filter((event) => event.type === "hide").length,
    1
  );

  const unloadLoad = context.page.loadCase("unload_case");
  context.page.onUnload();
  assert.equal(
    context.nativeLoadingEvents.filter((event) => event.type === "hide").length,
    2
  );
  pending.get("unload_case")(buildCase("unload_case"));
  assert.equal(await unloadLoad, false);
  assert.equal(context.page.data.caseItem.id, "new_case");
  assert.equal(
    context.nativeLoadingEvents.filter((event) => event.type === "hide").length,
    2
  );
});

await asyncTest("detail favorite requests access and performs immediately when ready", async () => {
  let toggleCalls = 0;
  const context = loadDetailInteractionPage({
    async toggleFavorite() {
      toggleCalls += 1;
      return {
        action: "added",
        favorite: { _id: "favorite_1" },
        isFavorited: true,
      };
    },
  });

  await context.page.toggleFavorite();

  assert.equal(context.accessRequests.length, 1);
  assert.equal(context.accessRequests[0].kind, "favorites");
  assert.equal(context.accessRequests[0].source, "detail_favorite");
  assert.equal(typeof context.accessRequests[0].resume, "function");
  assert.equal(toggleCalls, 1);
  assert.equal(context.page.data.favoriteLoading, false);
  assert.equal(context.page.data.isFavorited, true);
  assert.equal(context.page.data.favorite._id, "favorite_1");
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.toasts)),
    [{ title: "已收藏", icon: "success" }]
  );
});

await asyncTest("cancelling the access prompt unlocks the favorite action for the next tap", async () => {
  let toggleCalls = 0;
  const context = loadDetailInteractionPage({
    requestLibraryAccess: async () => ({ status: "cancelled" }),
    toggleFavorite: async () => {
      toggleCalls += 1;
      return {};
    },
  });

  await context.page.toggleFavorite();
  assert.equal(context.page.data.favoriteLoading, false);
  await context.page.toggleFavorite();

  assert.equal(context.accessRequests.length, 2);
  assert.equal(toggleCalls, 0);
  assert.equal(context.page.data.favoriteLoading, false);
  assert.equal(context.toasts.length, 0);
});

await asyncTest("returning after profile setup resumes the pending favorite exactly once", async () => {
  let pendingResume = null;
  let toggleCalls = 0;
  const context = loadDetailInteractionPage({
    requestLibraryAccess: async (request) => {
      pendingResume = request.resume;
      return { status: "redirected" };
    },
    resumePendingLibraryAction: async () => {
      if (!pendingResume) return false;
      const resume = pendingResume;
      pendingResume = null;
      await resume();
      return true;
    },
    toggleFavorite: async () => {
      toggleCalls += 1;
      return {
        action: "added",
        favorite: { _id: "favorite_1" },
        isFavorited: true,
      };
    },
  });

  await context.page.toggleFavorite();
  assert.equal(context.page.data.favoriteLoading, true);
  assert.equal(toggleCalls, 0);

  assert.equal(await context.page.onShow(), true);
  assert.equal(context.resumeSources[0], "detail_favorite");
  assert.equal(toggleCalls, 1);
  assert.equal(context.page.data.favoriteLoading, false);
  assert.equal(context.page.data.isFavorited, true);

  assert.equal(await context.page.onShow(), false);
  assert.equal(toggleCalls, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.toasts)),
    [{ title: "已收藏", icon: "success" }]
  );
});

await asyncTest("a resumed favorite failure explains that profile setup succeeded", async () => {
  let pendingResume = null;
  const context = loadDetailInteractionPage({
    requestLibraryAccess: async (request) => {
      pendingResume = request.resume;
      return { status: "redirected" };
    },
    resumePendingLibraryAction: async () => {
      if (!pendingResume) return false;
      const resume = pendingResume;
      pendingResume = null;
      await resume();
      return true;
    },
    toggleFavorite: async () => {
      throw new Error("write failed after setup");
    },
  });

  await context.page.toggleFavorite();
  assert.equal(await context.page.onShow(), true);

  assert.equal(context.page.data.favoriteLoading, false);
  assert.equal(context.page.data.isFavorited, false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.toasts)),
    [{ title: "资料已完成，收藏失败，请重试", icon: "none" }]
  );
});

await asyncTest("returning without a saved profile unlocks the favorite action", async () => {
  const accessStatuses = ["redirected", "cancelled"];
  const context = loadDetailInteractionPage({
    requestLibraryAccess: async () => ({
      status: accessStatuses.shift() || "cancelled",
    }),
    resumePendingLibraryAction: async () => false,
  });

  await context.page.toggleFavorite();
  assert.equal(context.page.data.favoriteLoading, true);

  assert.equal(await context.page.onShow(), false);
  assert.equal(context.page.data.favoriteLoading, false);

  await context.page.toggleFavorite();
  assert.equal(context.accessRequests.length, 2);
  assert.equal(context.page.data.favoriteLoading, false);
});

await asyncTest("access failures use verification and navigation specific copy", async () => {
  const accessResults = [
    { status: "error", stage: "access_check" },
    { status: "error", stage: "navigation" },
  ];
  const context = loadDetailInteractionPage({
    requestLibraryAccess: async () => accessResults.shift(),
  });

  await context.page.toggleFavorite();
  await context.page.toggleFavorite();

  assert.equal(context.page.data.favoriteLoading, false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.toasts)),
    [
      { title: "暂时无法验证资料，请重试", icon: "none" },
      { title: "暂时无法打开资料页，请重试", icon: "none" },
    ]
  );
});

await asyncTest("favorite mutation failures unlock and show one failure toast", async () => {
  const context = loadDetailInteractionPage({
    toggleFavorite: async () => {
      throw new Error("write failed");
    },
  });

  await context.page.toggleFavorite();

  assert.equal(context.page.data.favoriteLoading, false);
  assert.equal(context.page.data.isFavorited, false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.toasts)),
    [{ title: "收藏操作失败", icon: "none" }]
  );
});

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
      if (moduleName === "../../utils/libraryAccessService") {
        return {
          requestLibraryAccess: async () => ({ status: "cancelled" }),
          resumePendingLibraryAction: async () => false,
        };
      }
      if (moduleName === "../../utils/userService") {
        return { resumePendingProfileAction: async () => false };
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    wx: {
      showLoading() {},
      hideLoading() {},
    },
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
  assert.equal(page.data.currentImageUrl, "https://temp/display-7");
  assert.equal(page.data.customerServiceMessageImage, "https://temp/display-0");
  page.onGalleryChange({ detail: { current: 8 } });
  assert.equal(page.data.galleryItems[8].renderUrl, "https://temp/display-8");
  assert.equal(page.data.currentImageIndex, 8);
  assert.equal(page.data.currentImageUrl, "https://temp/display-8");
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

await asyncTest("detail shares the selected case with a direct-entry path", async () => {
  let page;
  const detailCase = {
    id: "case 1",
    title: "鎏金礼盒",
    packageTypes: [],
    styles: [],
    scenes: [],
    gallery: [
      {
        displayUrl: "https://example.com/case-1.jpg",
        thumbnailUrl: "https://example.com/case-1-thumb.jpg",
      },
    ],
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
        return { fetchCaseDetail: async () => detailCase };
      }
      if (moduleName === "../../utils/caseData") {
        return { formatJoined: (values, fallback = "") => (values || []).join("/") || fallback };
      }
      if (moduleName === "../../utils/customerServiceData") {
        return {
          CUSTOMER_SERVICE_SOURCE: { DETAIL: "detail" },
          buildCustomerMessageCard: () => ({
            enabled: false,
            title: "",
            path: "",
            imageUrl: "",
          }),
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
      if (moduleName === "../../utils/libraryAccessService") {
        return {
          requestLibraryAccess: async () => ({ status: "cancelled" }),
          resumePendingLibraryAction: async () => false,
        };
      }
      if (moduleName === "../../utils/userService") {
        return { resumePendingProfileAction: async () => false };
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    wx: {
      showLoading() {},
      hideLoading() {},
    },
  };

  vm.runInNewContext(readFileSync(pagePath, "utf8"), sandbox, {
    filename: pagePath,
  });
  page.setData = function setData(patch) {
    this.data = { ...this.data, ...patch };
  };
  await page.loadCase("case 1");

  assert.deepEqual(
    JSON.parse(JSON.stringify(page.onShareAppMessage())),
    {
      title: "鎏金礼盒｜金亿诚包装科技",
      path: "/pages/detail/index?id=case%201",
      imageUrl: "https://example.com/case-1.jpg",
    }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(page.onShareTimeline())),
    {
      title: "鎏金礼盒｜金亿诚包装科技",
      query: "id=case%201",
      imageUrl: "https://example.com/case-1.jpg",
    }
  );
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
