import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pagePath = resolve(__dirname, "../miniprogram/miniprogram/pages/contact/index.js");
const dataPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/contact/contactData.js"
);
const servicePath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/contact/contactService.js"
);
const wxmlPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/contact/index.wxml"
);
const wxssPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/contact/index.wxss"
);
function loadContactData() {
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(dataPath, "utf8"), {
    module,
    exports: module.exports,
  }, {
    filename: dataPath,
  });
  return module.exports.CONTACT_DATA;
}

function loadContactService(wxMock = {}) {
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(servicePath, "utf8"), {
    module,
    exports: module.exports,
    wx: wxMock,
    Error,
  }, {
    filename: servicePath,
  });
  return module.exports;
}

function loadContactPage(wxMock = {}, serviceMock = {}, runtimeMock = {}) {
  let page;
  const contactData = loadContactData();
  const fetchPublicContact =
    serviceMock.fetchPublicContact ||
    (() => Promise.reject(new Error("offline")));
  const sandbox = {
    Page(config) {
      page = config;
    },
    require(moduleName) {
      if (moduleName === "./contactData") {
        return { CONTACT_DATA: contactData };
      }
      if (moduleName === "./contactService") {
        return { fetchPublicContact };
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    setTimeout: runtimeMock.setTimeout || setTimeout,
    clearTimeout: runtimeMock.clearTimeout || clearTimeout,
    wx: {
      openLocation() {},
      previewImage() {},
      setClipboardData() {},
      showToast() {},
      showLoading() {},
      hideLoading() {},
      makePhoneCall() {},
      navigateTo() {},
      ...wxMock,
    },
  };
  vm.runInNewContext(readFileSync(pagePath, "utf8"), sandbox, {
    filename: pagePath,
  });
  page.setData = function setData(patch, callback) {
    this.data = { ...this.data, ...patch };
    if (callback) callback();
  };
  return page;
}

function settleWechatQrImages(page, failedIndexes = []) {
  const requestId = page.data.wechatQrRequestId;
  const images = [...page.data.wechatQrImages];
  images.forEach((_, index) => {
    const handler = failedIndexes.includes(index)
      ? "onWechatQrImageError"
      : "onWechatQrImageLoad";
    page[handler]({
      currentTarget: {
        dataset: { index, requestId },
      },
    });
  });
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
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

await test("contact data starts without the retired local QR fallback", () => {
  const data = plain(loadContactData());

  assert.equal(data.storeName, "金亿诚包装科技");
  assert.equal(
    data.address,
    "贵州省遵义市仁怀市国际商贸中心酒包材市场2栋1楼111-118号"
  );
  assert.equal(Number.isFinite(data.latitude), true);
  assert.equal(Number.isFinite(data.longitude), true);
  assert.equal(data.latitude >= -90 && data.latitude <= 90, true);
  assert.equal(data.longitude >= -180 && data.longitude <= 180, true);
  assert.deepEqual(data.storeImages, []);
  assert.equal(data.storeImages.length <= 9, true);
  assert.deepEqual(data.wechatQrImages, []);
  assert.equal(data.wechatQrImage, "");
  assert.deepEqual(data.phoneNumbers, []);
  assert.equal(
    readFileSync(dataPath, "utf8").includes("boss-wechat-qr.jpg"),
    false
  );
});

await test("contact page starts with no QR image while cloud data is loading", () => {
  const page = loadContactPage();

  assert.deepEqual(plain(page.data.wechatQrImages), []);
  assert.equal(page.data.wechatQrImage, "");
  assert.equal(page.data.wechatQrLoading, true);
  assert.equal(page.data.wechatQrError, false);
});

await test("public contact service requests contactAdmin and normalizes its config", async () => {
  let request;
  const service = loadContactService({
    cloud: {
      async callFunction(options) {
        request = options;
        return {
          result: {
            ok: true,
            isAdmin: true,
            config: {
              storeImages: Array.from(
                { length: 10 },
                (_, index) => ` cloud://store-${index + 1} `
              ),
              wechatQrImages: [
                " cloud://qr-1 ",
                "",
                "cloud://qr-2",
                "cloud://qr-3",
              ],
              phoneNumbers: [
                {
                  displayNumber: "0851-12345678",
                  dialNumber: "085112345678",
                },
                "+86 188 8527 4143",
                { displayNumber: "", dialNumber: "" },
              ],
            },
          },
        };
      },
    },
  });

  const result = await service.fetchPublicContact();

  assert.deepEqual(plain(request), {
    name: "contactAdmin",
    data: { action: "getPublicContact" },
  });
  assert.deepEqual(plain(result), {
    isAdmin: true,
    storeImages: Array.from(
      { length: 9 },
      (_, index) => `cloud://store-${index + 1}`
    ),
    wechatQrImages: ["cloud://qr-1", "cloud://qr-2"],
    wechatQrImage: "cloud://qr-1",
    phoneNumbers: [
      { displayNumber: "0851-12345678", dialNumber: "085112345678" },
      { displayNumber: "+86 188 8527 4143", dialNumber: "+8618885274143" },
    ],
  });
});

await test("public contact service keeps the legacy single QR field compatible", async () => {
  const service = loadContactService({
    cloud: {
      async callFunction() {
        return {
          result: {
            ok: true,
            config: {
              wechatQrImage: " https://example.test/legacy-qr.png ",
            },
          },
        };
      },
    },
  });

  const result = await service.fetchPublicContact();

  assert.deepEqual(plain(result.wechatQrImages), [
    "https://example.test/legacy-qr.png",
  ]);
  assert.equal(
    result.wechatQrImage,
    "https://example.test/legacy-qr.png"
  );
});

await test("contact page merges valid cloud fields and exposes the admin editor", async () => {
  let navigatedTo = "";
  const page = loadContactPage(
    {
      navigateTo({ url }) {
        navigatedTo = url;
      },
    },
    {
      async fetchPublicContact() {
        return {
          isAdmin: true,
          storeImages: ["https://example.test/store.jpg"],
          wechatQrImages: [
            "https://example.test/qr-1.png",
            "https://example.test/qr-2.png",
            "https://example.test/qr-3.png",
          ],
          wechatQrImage: "https://example.test/qr-1.png",
          phoneNumbers: [
            { displayNumber: "0851-12345678", dialNumber: "085112345678" },
          ],
        };
      },
    }
  );

  await page.loadPublicContact();
  settleWechatQrImages(page);
  page.openContactAdmin();

  assert.equal(page.data.isAdmin, true);
  assert.deepEqual(plain(page.data.storeImages), [
    "https://example.test/store.jpg",
  ]);
  assert.deepEqual(plain(page.data.wechatQrImages), [
    "https://example.test/qr-1.png",
    "https://example.test/qr-2.png",
  ]);
  assert.equal(page.data.wechatQrImage, "https://example.test/qr-1.png");
  assert.deepEqual(plain(page.data.phoneNumbers), [
    { displayNumber: "0851-12345678", dialNumber: "085112345678" },
  ]);
  assert.equal(page.data.activeStoreImageIndex, 0);
  assert.equal(page.data.storeImagesLoading, false);
  assert.equal(page.data.storeImagesError, false);
  assert.equal(navigatedTo, "/pages/contact-admin/edit");
});

await test("contact page keeps the legacy single cloud QR field compatible", async () => {
  const page = loadContactPage({}, {
    async fetchPublicContact() {
      return {
        isAdmin: false,
        storeImages: [],
        wechatQrImage: "https://example.test/legacy-cloud-qr.png",
        phoneNumbers: [],
      };
    },
  });

  await page.loadPublicContact();
  settleWechatQrImages(page);

  assert.deepEqual(plain(page.data.wechatQrImages), [
    "https://example.test/legacy-cloud-qr.png",
  ]);
  assert.equal(
    page.data.wechatQrImage,
    "https://example.test/legacy-cloud-qr.png"
  );
});

await test("empty or failed cloud reads never restore the retired local QR", async () => {
  const nativeLoadingEvents = [];
  const page = loadContactPage({
    showLoading(request) {
      nativeLoadingEvents.push({ type: "show", request });
    },
    hideLoading() {
      nativeLoadingEvents.push({ type: "hide" });
    },
  }, {
    async fetchPublicContact() {
      return {
        isAdmin: false,
        storeImages: [],
        wechatQrImages: [],
        wechatQrImage: "",
        phoneNumbers: [],
      };
    },
  });
  page.data.storeImages = ["https://example.test/previous-cloud.jpg"];

  await page.loadPublicContact();
  assert.deepEqual(plain(page.data.storeImages), []);
  assert.equal(page.data.storeImagesLoading, false);
  assert.equal(page.data.storeImagesError, false);
  assert.deepEqual(plain(page.data.wechatQrImages), []);
  assert.equal(page.data.wechatQrImage, "");
  assert.equal(page.data.wechatQrLoading, false);
  assert.equal(page.data.wechatQrError, false);
  assert.deepEqual(plain(page.data.phoneNumbers), []);
  assert.deepEqual(plain(nativeLoadingEvents), [
    { type: "show", request: { title: "加载中", mask: true } },
    { type: "hide" },
  ]);

  page.data.storeImages = ["https://example.test/current-cloud.jpg"];
  page.data.wechatQrImages = ["https://example.test/current-cloud-qr.jpg"];
  page.data.wechatQrImage = "https://example.test/current-cloud-qr.jpg";
  page.data.phoneNumbers = [
    { displayNumber: "123", dialNumber: "123" },
  ];
  page.data.isAdmin = true;
  const offlinePage = loadContactPage({}, {
    async fetchPublicContact() {
      throw new Error("offline");
    },
  });
  offlinePage.data = page.data;

  await offlinePage.loadPublicContact();

  assert.deepEqual(plain(offlinePage.data.storeImages), []);
  assert.equal(offlinePage.data.storeImagesLoading, false);
  assert.equal(offlinePage.data.storeImagesError, true);
  assert.deepEqual(plain(offlinePage.data.wechatQrImages), []);
  assert.equal(offlinePage.data.wechatQrImage, "");
  assert.equal(offlinePage.data.wechatQrLoading, false);
  assert.equal(offlinePage.data.wechatQrError, true);
  assert.deepEqual(plain(offlinePage.data.phoneNumbers), [
    { displayNumber: "123", dialNumber: "123" },
  ]);
  assert.equal(offlinePage.data.isAdmin, false);

  const freshOfflinePage = loadContactPage({}, {
    async fetchPublicContact() {
      throw new Error("offline");
    },
  });
  await freshOfflinePage.loadPublicContact();
  assert.deepEqual(plain(freshOfflinePage.data.storeImages), []);
  assert.equal(freshOfflinePage.data.storeImagesLoading, false);
  assert.equal(freshOfflinePage.data.storeImagesError, true);
  assert.deepEqual(plain(freshOfflinePage.data.wechatQrImages), []);
  assert.equal(freshOfflinePage.data.wechatQrImage, "");
  assert.equal(freshOfflinePage.data.wechatQrLoading, false);
  assert.equal(freshOfflinePage.data.wechatQrError, true);
});

await test("contact refresh hides old QR images until every new image is loaded", async () => {
  let resolveContact;
  const nativeLoadingEvents = [];
  const page = loadContactPage({
    showLoading(request) {
      nativeLoadingEvents.push({ type: "show", request });
    },
    hideLoading() {
      nativeLoadingEvents.push({ type: "hide" });
    },
  }, {
    fetchPublicContact() {
      return new Promise((resolveContactRequest) => {
        resolveContact = resolveContactRequest;
      });
    },
  });
  page.data.storeImages = ["https://example.test/previous-cloud.jpg"];
  page.data.wechatQrImages = ["https://example.test/previous-cloud-qr.jpg"];
  page.data.wechatQrImage = "https://example.test/previous-cloud-qr.jpg";

  const loading = page.loadPublicContact();

  assert.deepEqual(plain(page.data.storeImages), []);
  assert.deepEqual(plain(page.data.wechatQrImages), []);
  assert.equal(page.data.wechatQrImage, "");
  assert.equal(page.data.storeImagesLoading, true);
  assert.equal(page.data.wechatQrLoading, true);
  assert.equal(page.data.wechatQrError, false);
  assert.deepEqual(plain(nativeLoadingEvents), [
    { type: "show", request: { title: "加载中", mask: true } },
  ]);
  resolveContact({
    isAdmin: false,
    storeImages: ["https://example.test/new-cloud.jpg"],
    wechatQrImages: [
      "https://example.test/new-cloud-qr-1.jpg",
      "https://example.test/new-cloud-qr-2.jpg",
    ],
    wechatQrImage: "https://example.test/new-cloud-qr-1.jpg",
    phoneNumbers: [],
  });
  await loading;

  assert.deepEqual(plain(page.data.storeImages), [
    "https://example.test/new-cloud.jpg",
  ]);
  assert.deepEqual(plain(page.data.wechatQrImages), [
    "https://example.test/new-cloud-qr-1.jpg",
    "https://example.test/new-cloud-qr-2.jpg",
  ]);
  assert.equal(
    page.data.wechatQrImage,
    "https://example.test/new-cloud-qr-1.jpg"
  );
  assert.equal(page.data.storeImagesLoading, false);
  assert.equal(page.data.storeImagesError, false);
  assert.equal(page.data.wechatQrLoading, true);
  assert.equal(page.data.wechatQrError, false);
  assert.deepEqual(nativeLoadingEvents.map((event) => event.type), ["show"]);

  page.onWechatQrImageLoad({
    currentTarget: {
      dataset: { index: 0, requestId: page.data.wechatQrRequestId },
    },
  });
  assert.equal(page.data.wechatQrLoading, true);
  assert.deepEqual(nativeLoadingEvents.map((event) => event.type), ["show"]);

  page.onWechatQrImageLoad({
    currentTarget: {
      dataset: { index: 1, requestId: page.data.wechatQrRequestId },
    },
  });

  assert.equal(page.data.wechatQrLoading, false);
  assert.deepEqual(nativeLoadingEvents.map((event) => event.type), [
    "show",
    "hide",
  ]);
});

await test("failed new QR images close native loading and show an error", async () => {
  const nativeLoadingEvents = [];
  const page = loadContactPage({
    showLoading() {
      nativeLoadingEvents.push("show");
    },
    hideLoading() {
      nativeLoadingEvents.push("hide");
    },
  }, {
    async fetchPublicContact() {
      return {
        isAdmin: false,
        storeImages: [],
        wechatQrImages: [
          "https://example.test/broken-qr-1.jpg",
          "https://example.test/broken-qr-2.jpg",
        ],
        phoneNumbers: [],
      };
    },
  });

  await page.loadPublicContact();
  settleWechatQrImages(page, [0, 1]);

  assert.deepEqual(plain(page.data.wechatQrImages), []);
  assert.equal(page.data.wechatQrImage, "");
  assert.equal(page.data.wechatQrLoading, false);
  assert.equal(page.data.wechatQrError, true);
  assert.deepEqual(nativeLoadingEvents, ["show", "hide"]);
});

await test("a partial QR image failure keeps the successfully loaded image", async () => {
  const nativeLoadingEvents = [];
  const page = loadContactPage({
    showLoading() {
      nativeLoadingEvents.push("show");
    },
    hideLoading() {
      nativeLoadingEvents.push("hide");
    },
  }, {
    async fetchPublicContact() {
      return {
        isAdmin: false,
        storeImages: [],
        wechatQrImages: [
          "https://example.test/broken-qr.jpg",
          "https://example.test/working-qr.jpg",
        ],
        phoneNumbers: [],
      };
    },
  });

  await page.loadPublicContact();
  settleWechatQrImages(page, [0]);

  assert.deepEqual(plain(page.data.wechatQrImages), [
    "https://example.test/working-qr.jpg",
  ]);
  assert.equal(page.data.wechatQrImage, "https://example.test/working-qr.jpg");
  assert.equal(page.data.wechatQrLoading, false);
  assert.equal(page.data.wechatQrError, false);
  assert.deepEqual(nativeLoadingEvents, ["show", "hide"]);
});

await test("a QR image timeout cannot leave the native loading overlay stuck", async () => {
  const nativeLoadingEvents = [];
  const clearedTimeouts = [];
  let pendingTimeout;
  const page = loadContactPage({
    showLoading() {
      nativeLoadingEvents.push("show");
    },
    hideLoading() {
      nativeLoadingEvents.push("hide");
    },
  }, {
    async fetchPublicContact() {
      return {
        isAdmin: false,
        storeImages: [],
        wechatQrImages: ["https://example.test/hanging-qr.jpg"],
        phoneNumbers: [],
      };
    },
  }, {
    setTimeout(callback, delay) {
      pendingTimeout = { callback, delay };
      return 42;
    },
    clearTimeout(timeoutId) {
      clearedTimeouts.push(timeoutId);
    },
  });

  await page.loadPublicContact();
  assert.equal(pendingTimeout.delay, 15000);
  assert.deepEqual(nativeLoadingEvents, ["show"]);

  pendingTimeout.callback();

  assert.deepEqual(plain(page.data.wechatQrImages), []);
  assert.equal(page.data.wechatQrLoading, false);
  assert.equal(page.data.wechatQrError, true);
  assert.deepEqual(nativeLoadingEvents, ["show", "hide"]);
  assert.deepEqual(clearedTimeouts, [42]);
});

await test("only the latest overlapping contact request can update the QR image", async () => {
  const pendingRequests = [];
  const nativeLoadingEvents = [];
  const page = loadContactPage({
    showLoading() {
      nativeLoadingEvents.push("show");
    },
    hideLoading() {
      nativeLoadingEvents.push("hide");
    },
  }, {
    fetchPublicContact() {
      return new Promise((resolveRequest) => {
        pendingRequests.push(resolveRequest);
      });
    },
  });

  const olderRequest = page.loadPublicContact();
  const latestRequest = page.loadPublicContact();
  pendingRequests[1]({
    isAdmin: false,
    storeImages: [],
    wechatQrImages: ["https://example.test/latest-qr.jpg"],
    phoneNumbers: [],
  });
  await latestRequest;
  assert.deepEqual(nativeLoadingEvents, ["show"]);
  settleWechatQrImages(page);
  assert.deepEqual(nativeLoadingEvents, ["show", "hide"]);
  pendingRequests[0]({
    isAdmin: false,
    storeImages: [],
    wechatQrImages: ["https://example.test/stale-qr.jpg"],
    phoneNumbers: [],
  });
  await olderRequest;

  assert.deepEqual(plain(page.data.wechatQrImages), [
    "https://example.test/latest-qr.jpg",
  ]);
  assert.equal(page.data.wechatQrImage, "https://example.test/latest-qr.jpg");
  assert.equal(page.data.wechatQrLoading, false);
  assert.equal(page.data.wechatQrError, false);
  assert.deepEqual(nativeLoadingEvents, ["show", "hide"]);
});

await test("stale QR image events cannot finish the latest contact request", async () => {
  const pendingRequests = [];
  const nativeLoadingEvents = [];
  const page = loadContactPage({
    showLoading() {
      nativeLoadingEvents.push("show");
    },
    hideLoading() {
      nativeLoadingEvents.push("hide");
    },
  }, {
    fetchPublicContact() {
      return new Promise((resolveRequest) => {
        pendingRequests.push(resolveRequest);
      });
    },
  });

  const firstLoad = page.loadPublicContact();
  pendingRequests[0]({
    isAdmin: false,
    storeImages: [],
    wechatQrImages: ["https://example.test/old-qr.jpg"],
    phoneNumbers: [],
  });
  await firstLoad;
  const staleRequestId = page.data.wechatQrRequestId;

  const latestLoad = page.loadPublicContact();
  page.onWechatQrImageLoad({
    currentTarget: {
      dataset: { index: 0, requestId: staleRequestId },
    },
  });
  assert.deepEqual(nativeLoadingEvents, ["show"]);

  pendingRequests[1]({
    isAdmin: false,
    storeImages: [],
    wechatQrImages: ["https://example.test/latest-qr.jpg"],
    phoneNumbers: [],
  });
  await latestLoad;
  settleWechatQrImages(page);

  assert.deepEqual(plain(page.data.wechatQrImages), [
    "https://example.test/latest-qr.jpg",
  ]);
  assert.deepEqual(nativeLoadingEvents, ["show", "hide"]);
});

await test("leaving during a contact read hides loading and ignores late images", async () => {
  let resolveContact;
  const nativeLoadingEvents = [];
  const page = loadContactPage({
    showLoading() {
      nativeLoadingEvents.push("show");
    },
    hideLoading() {
      nativeLoadingEvents.push("hide");
    },
  }, {
    fetchPublicContact() {
      return new Promise((resolveRequest) => {
        resolveContact = resolveRequest;
      });
    },
  });

  const loading = page.loadPublicContact();
  page.onHide();
  page.onUnload();
  assert.deepEqual(nativeLoadingEvents, ["show", "hide"]);

  resolveContact({
    isAdmin: false,
    storeImages: [],
    wechatQrImages: ["https://example.test/late-qr.jpg"],
    phoneNumbers: [],
  });
  await loading;

  assert.deepEqual(plain(page.data.wechatQrImages), []);
  assert.equal(page.data.wechatQrImage, "");
  assert.deepEqual(nativeLoadingEvents, ["show", "hide"]);
});

await test("contact page previews store images and the WeChat QR image", () => {
  const previews = [];
  const page = loadContactPage({
    previewImage(options) {
      previews.push(options);
    },
  });
  page.data.storeImages = [
    "https://example.test/store-1.jpg",
    "https://example.test/store-2.jpg",
  ];
  page.data.wechatQrImages = [
    "https://example.test/qr-1.png",
    "https://example.test/qr-2.png",
  ];
  page.data.wechatQrImage = page.data.wechatQrImages[0];

  page.previewStoreImage({ currentTarget: { dataset: { index: 1 } } });
  page.previewWechatQr({ currentTarget: { dataset: { index: 1 } } });

  assert.equal(previews[0].current, page.data.storeImages[1]);
  assert.deepEqual(plain(previews[0].urls), plain(page.data.storeImages));
  assert.equal(previews[1].current, page.data.wechatQrImages[1]);
  assert.deepEqual(plain(previews[1].urls), plain(page.data.wechatQrImages));
});

await test("contact page ignores store preview taps while no cloud image is available", () => {
  let previewCount = 0;
  const page = loadContactPage({
    previewImage() {
      previewCount += 1;
    },
  });

  page.previewStoreImage({ currentTarget: { dataset: { index: 0 } } });

  assert.equal(previewCount, 0);
});

await test("contact page dials either configured phone and ignores cancellations", () => {
  const calls = [];
  const toastTitles = [];
  const page = loadContactPage({
    makePhoneCall(options) {
      calls.push(options.phoneNumber);
      if (calls.length === 1) {
        options.fail({ errMsg: "makePhoneCall:fail cancel" });
      } else {
        options.fail({ errMsg: "makePhoneCall:fail system error" });
      }
    },
    showToast(options) {
      toastTitles.push(options.title);
    },
  });
  page.data.phoneNumbers = [
    { displayNumber: "0851-12345678", dialNumber: "085112345678" },
    { displayNumber: "188 8527 4143", dialNumber: "18885274143" },
  ];

  page.callPhone({ currentTarget: { dataset: { index: 0 } } });
  page.callPhone({ currentTarget: { dataset: { index: 1 } } });

  assert.deepEqual(calls, ["085112345678", "18885274143"]);
  assert.deepEqual(toastTitles, ["暂时无法拨打电话"]);
});

await test("contact page does not dial without a configured phone", () => {
  let callCount = 0;
  const page = loadContactPage({
    makePhoneCall() {
      callCount += 1;
    },
  });

  page.callPhone({ currentTarget: { dataset: { index: 0 } } });

  assert.equal(callCount, 0);
});

await test("contact page opens the fixed store location", () => {
  let locationOptions;
  const page = loadContactPage({
    openLocation(options) {
      locationOptions = options;
    },
  });

  page.openStoreLocation();

  assert.equal(locationOptions.latitude, page.data.latitude);
  assert.equal(locationOptions.longitude, page.data.longitude);
  assert.equal(locationOptions.name, "金亿诚包装科技");
  assert.equal(locationOptions.address, page.data.address);
  assert.equal(locationOptions.scale, 18);
});

await test("map failures copy the address and show a clear fallback", () => {
  let copiedAddress = "";
  let toastTitle = "";
  const page = loadContactPage({
    openLocation(options) {
      options.fail();
    },
    setClipboardData(options) {
      copiedAddress = options.data;
      options.success();
    },
    showToast(options) {
      toastTitle = options.title;
    },
  });

  page.openStoreLocation();

  assert.equal(copiedAddress, page.data.address);
  assert.equal(toastTitle, "地图打开失败，地址已复制");
});

await test("contact page exposes friend and timeline sharing", () => {
  const page = loadContactPage();

  assert.deepEqual(plain(page.onShareAppMessage()), {
    title: "联系我们｜金亿诚包装科技",
    path: "/pages/contact/index",
  });
  assert.deepEqual(plain(page.onShareTimeline()), {
    title: "联系我们｜金亿诚包装科技",
  });

  page.data.storeImages = ["https://example.test/current-cloud.jpg"];
  assert.equal(
    page.onShareAppMessage().imageUrl,
    "https://example.test/current-cloud.jpg"
  );
  assert.equal(
    page.onShareTimeline().imageUrl,
    "https://example.test/current-cloud.jpg"
  );
});

await test("contact page enables gallery and long-press QR behavior", () => {
  const wxml = readFileSync(wxmlPath, "utf8");
  const wxss = readFileSync(wxssPath, "utf8");

  assert.equal(wxml.includes('wx:for="{{storeImages}}"'), true);
  assert.equal(wxml.includes('wx:if="{{storeImages.length}}"'), true);
  assert.equal(wxml.includes('wx:elif="{{storeImagesLoading}}"'), true);
  assert.equal(wxml.includes('wx:elif="{{storeImagesError}}"'), true);
  assert.equal(wxml.includes("门店图片暂时无法加载，请稍后重试"), true);
  assert.equal(wxml.includes("门店图片暂未配置"), true);
  assert.equal(wxml.includes('bindtap="previewStoreImage"'), true);
  assert.equal(wxml.includes('lazy-load="{{index > 0}}"'), true);
  assert.equal(wxml.includes('bindtap="openStoreLocation"'), true);
  assert.equal(wxml.includes("map-button-icon"), false);
  assert.equal(
    wxml.includes('<view class="map-button-label">打开地图导航</view>'),
    true
  );
  assert.equal(wxml.includes('wx:if="{{isAdmin}}"'), true);
  assert.equal(wxml.includes('bindtap="openContactAdmin"'), true);
  assert.equal(wxml.includes("联系电话暂未配置"), true);
  assert.equal(wxml.includes('bindtap="callPhone"'), true);
  assert.equal(wxml.includes("<button"), true);
  assert.equal(wxml.includes('show-menu-by-longpress="{{true}}"'), true);
  assert.equal(wxml.includes('lazy-load="{{true}}"'), false);
  assert.equal(wxml.includes('data-request-id="{{wechatQrRequestId}}"'), true);
  assert.equal(wxml.includes('bindload="onWechatQrImageLoad"'), true);
  assert.equal(wxml.includes('binderror="onWechatQrImageError"'), true);
  assert.equal(wxml.includes("qr-image-loading"), true);
  assert.equal(wxss.includes(".qr-image-loading"), true);
  assert.equal(wxml.includes('wx:if="{{wechatQrImages.length}}"'), true);
  assert.equal(wxml.includes('wx:for="{{wechatQrImages}}"'), true);
  assert.equal(wxml.includes('wx:elif="{{wechatQrError}}"'), true);
  assert.equal(wxml.includes("微信二维码加载中…"), false);
  assert.equal(
    wxml.includes("微信二维码暂时无法加载，请稍后重试"),
    true
  );
  assert.equal(wxml.includes("微信二维码暂未配置"), true);
  assert.equal(wxml.includes('bindtap="previewWechatQr"'), true);
});
