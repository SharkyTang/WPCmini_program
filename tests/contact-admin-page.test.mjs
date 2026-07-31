import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/contact-admin"
);
const pagePath = resolve(adminRoot, "edit.js");
const dataPath = resolve(adminRoot, "utils/contactAdminData.js");
const servicePath = resolve(adminRoot, "utils/contactAdminService.js");
const wxmlPath = resolve(adminRoot, "edit.wxml");

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadCommonJsModule(path, globals = {}) {
  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    console,
    Date,
    Math,
    Set,
    ...globals,
  };
  vm.runInNewContext(readFileSync(path, "utf8"), sandbox, {
    filename: path,
  });
  return module.exports;
}

const dataLogic = loadCommonJsModule(dataPath);

function createDeferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function loadContactAdminPage(options = {}) {
  let page;
  const saveDeferred = options.deferSave ? createDeferred() : null;
  const calls = {
    accessChecks: 0,
    draftRequests: 0,
    mediaOptions: [],
    previews: [],
    toasts: [],
    uploads: [],
    activeUploads: 0,
    maxConcurrentUploads: 0,
    cleanups: [],
    saves: [],
    navigateBack: 0,
    warnings: [],
  };
  const service = {
    async checkContactAdminAccess() {
      calls.accessChecks += 1;
      if (options.accessError) throw options.accessError;
      return options.isAdmin !== false;
    },
    async fetchContactAdminDraft() {
      calls.draftRequests += 1;
      if (options.draftError) throw options.draftError;
      return (
        options.draft || {
          item: {
            storeImageFileIds: ["cloud://env/store-existing.jpg"],
            storeImageUrls: ["https://example.com/store-existing.jpg"],
            wechatQrFileId: "cloud://env/qr-existing.png",
            wechatQrUrl: "https://example.com/qr-existing.png",
            phoneNumbers: ["0851-12345678", ""],
            revision: 3,
          },
        }
      );
    },
    async uploadContactImage({ filePath, cloudPath }) {
      const uploadIndex = calls.uploads.length;
      calls.uploads.push({ filePath, cloudPath });
      calls.activeUploads += 1;
      calls.maxConcurrentUploads = Math.max(
        calls.maxConcurrentUploads,
        calls.activeUploads
      );
      try {
        await Promise.resolve();
        await Promise.resolve();
        if (options.uploadFailureIndex === uploadIndex) {
          throw new Error("upload failed");
        }
        return `cloud://env/new-${uploadIndex}.jpg`;
      } finally {
        calls.activeUploads -= 1;
      }
    },
    async cleanupContactFiles(fileIDs) {
      calls.cleanups.push([...fileIDs]);
      if (options.cleanupError) throw options.cleanupError;
      return fileIDs;
    },
    async saveContactAdmin(contact, revision) {
      calls.saves.push({ contact, revision });
      if (options.saveError) throw options.saveError;
      if (saveDeferred) await saveDeferred.promise;
      return { revision: revision + 1 };
    },
  };
  const sandbox = {
    Page(config) {
      page = config;
    },
    require(moduleName) {
      if (moduleName === "./utils/contactAdminData") return dataLogic;
      if (moduleName === "./utils/contactAdminService") return service;
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    console: {
      ...console,
      warn(...args) {
        calls.warnings.push(args);
      },
    },
    setTimeout(callback) {
      callback();
      return 1;
    },
    wx: {
      chooseMedia(mediaOptions) {
        calls.mediaOptions.push(mediaOptions);
      },
      previewImage(previewOptions) {
        calls.previews.push(previewOptions);
      },
      showToast(toast) {
        calls.toasts.push(toast);
      },
      navigateBack() {
        calls.navigateBack += 1;
      },
    },
  };

  vm.runInNewContext(readFileSync(pagePath, "utf8"), sandbox, {
    filename: pagePath,
  });
  page.setData = function setData(nextData) {
    this.data = {
      ...this.data,
      ...nextData,
    };
  };
  return {
    page,
    calls,
    saveDeferred,
  };
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

await test("phone validation supports mobile, landline, 400 and Chinese parentheses", () => {
  const valid = dataLogic.validatePhoneNumbers([
    "+86（188）1234-5678",
    "(0851) 1234 5678",
  ]);
  assert.equal(valid.valid, true);
  assert.deepEqual(plain(valid.phoneNumbers), [
    "+86（188）1234-5678",
    "(0851) 1234 5678",
  ]);
  assert.deepEqual(plain(valid.dialNumbers), [
    "+8618812345678",
    "085112345678",
  ]);

  assert.equal(
    dataLogic.validatePhoneNumbers(["400-123-4567", ""]).valid,
    true
  );
  assert.equal(dataLogic.validatePhoneNumbers(["", ""]).valid, true);
});

await test("phone validation rejects invalid characters, misplaced plus and duplicates", () => {
  assert.equal(
    dataLogic.validatePhoneNumbers(["188a12345678", ""]).valid,
    false
  );
  assert.equal(
    dataLogic.validatePhoneNumbers(["188+12345678", ""]).valid,
    false
  );
  const duplicate = dataLogic.validatePhoneNumbers([
    "188-1234-5678",
    "188 1234 5678",
  ]);
  assert.equal(duplicate.valid, false);
  assert.equal(duplicate.message, "两个联系电话不能重复");
});

await test("draft normalization keeps at most four cloud images and two phones", () => {
  const draft = dataLogic.normalizeContactAdminDraft({
    item: {
      storeImages: Array.from({ length: 5 }, (_, index) => ({
        fileID: `cloud://env/store-${index}.jpg`,
        url: `https://example.com/store-${index}.jpg`,
      })),
      wechatQr: {
        fileID: "cloud://env/qr.png",
        url: "https://example.com/qr.png",
      },
      phoneNumbers: ["1 8888 8888", "400-123-4567", "third"],
      revision: 8,
    },
  });
  assert.equal(draft.storeImages.length, 4);
  assert.equal(draft.wechatQr.fileID, "cloud://env/qr.png");
  assert.deepEqual(plain(draft.phoneNumbers), [
    "1 8888 8888",
    "400-123-4567",
  ]);
  assert.equal(draft.revision, 8);
});

await test("draft normalization restores structured phone numbers returned by cloud", () => {
  const draft = dataLogic.normalizeContactAdminDraft({
    item: {
      phoneNumbers: [
        {
          displayNumber: "0851-1234 5678",
          dialNumber: "085112345678",
        },
        {
          displayNumber: "+86 188-8527-4143",
          dialNumber: "+8618885274143",
        },
      ],
    },
  });

  assert.deepEqual(plain(draft.phoneNumbers), [
    "0851-1234 5678",
    "+86 188-8527-4143",
  ]);
});

await test("cloud paths are limited to the contact asset directories", () => {
  assert.match(
    dataLogic.buildContactAssetCloudPath(
      "store",
      "/tmp/photo.JPEG",
      "store-one"
    ),
    /^contact-assets\/store\/store-one\.jpeg$/
  );
  assert.match(
    dataLogic.buildContactAssetCloudPath(
      "wechat",
      "/tmp/qr.png",
      "qr-one"
    ),
    /^contact-assets\/wechat\/qr-one\.png$/
  );
});

await test("service uses contactAdmin actions and native cloud upload", async () => {
  const calls = {
    functions: [],
    uploads: [],
  };
  const service = loadCommonJsModule(servicePath, {
    wx: {
      cloud: {
        async callFunction(request) {
          calls.functions.push(request);
          if (request.data.action === "checkAccess") {
            return { result: { ok: true, isAdmin: true } };
          }
          return { result: { ok: true, deletedFileIds: request.data.fileIDs || [] } };
        },
        async uploadFile(request) {
          calls.uploads.push(request);
          return { fileID: "cloud://env/new.jpg" };
        },
      },
    },
  });

  assert.equal(await service.checkContactAdminAccess(), true);
  await service.fetchContactAdminDraft();
  await service.saveContactAdmin(
    {
      storeImageFileIds: [],
      wechatQrFileId: "",
      phoneNumbers: [],
    },
    2
  );
  await service.cleanupContactFiles([
    "cloud://env/a.jpg",
    "cloud://env/a.jpg",
    "/local/not-cloud.jpg",
  ]);
  assert.equal(
    await service.uploadContactImage({
      filePath: "/tmp/a.jpg",
      cloudPath: "contact-assets/store/a.jpg",
    }),
    "cloud://env/new.jpg"
  );

  assert.deepEqual(
    calls.functions.map((request) => request.data.action),
    [
      "checkAccess",
      "getContactDraft",
      "saveContact",
      "cleanupUnreferencedFiles",
    ]
  );
  assert.deepEqual(plain(calls.functions[2].data), {
    action: "saveContact",
    contact: {
      storeImageFileIds: [],
      wechatQrFileId: "",
      phoneNumbers: [],
    },
    revision: 2,
  });
  assert.deepEqual(plain(calls.functions[3].data.fileIDs), [
    "cloud://env/a.jpg",
  ]);
  assert.deepEqual(plain(calls.uploads[0]), {
    filePath: "/tmp/a.jpg",
    cloudPath: "contact-assets/store/a.jpg",
  });
});

await test("deep links are gated before draft loading, selection and saving", async () => {
  const { page, calls } = loadContactAdminPage({ isAdmin: false });

  await page.onLoad();
  page.chooseStoreImages();
  await page.saveContact();

  assert.equal(page.data.accessChecked, true);
  assert.equal(page.data.isAdmin, false);
  assert.equal(calls.draftRequests, 0);
  assert.equal(calls.mediaOptions.length, 0);
  assert.equal(calls.saves.length, 0);
  assert.equal(calls.toasts.at(-1).title, "当前微信身份无管理权限");
});

await test("store picker uses native compressed image selection and honors four-image limit", async () => {
  const { page, calls } = loadContactAdminPage({
    draft: {
      item: {
        storeImageFileIds: [],
        storeImageUrls: [],
        phoneNumbers: [],
        revision: 0,
      },
    },
  });
  await page.onLoad();

  page.chooseStoreImages();
  assert.equal(calls.mediaOptions[0].count, 4);
  assert.deepEqual(plain(calls.mediaOptions[0].mediaType), ["image"]);
  assert.deepEqual(plain(calls.mediaOptions[0].sourceType), [
    "album",
    "camera",
  ]);
  assert.deepEqual(plain(calls.mediaOptions[0].sizeType), ["compressed"]);

  calls.mediaOptions[0].success({
    tempFiles: [
      { tempFilePath: "/tmp/store-1.jpg", size: 1000 },
      { tempFilePath: "/tmp/store-2.jpg", size: 1000 },
      { tempFilePath: "/tmp/store-3.jpg", size: 1000 },
      { tempFilePath: "/tmp/store-4.jpg", size: 1000 },
      { tempFilePath: "/tmp/store-5.jpg", size: 1000 },
    ],
  });
  assert.equal(page.data.storeImages.length, 4);
  assert.equal(page.data.storeImages.every((image) => image.isPending), true);

  page.chooseStoreImages();
  assert.equal(calls.mediaOptions.length, 1);
  assert.match(calls.toasts.at(-1).title, /最多上传 4 张/);
});

await test("QR picker requests one original image and previews it", async () => {
  const { page, calls } = loadContactAdminPage();
  await page.onLoad();

  page.chooseWechatQr();
  const picker = calls.mediaOptions[0];
  assert.equal(picker.count, 1);
  assert.deepEqual(plain(picker.mediaType), ["image"]);
  assert.deepEqual(plain(picker.sourceType), ["album", "camera"]);
  assert.deepEqual(plain(picker.sizeType), ["original"]);

  picker.success({
    tempFiles: [{ tempFilePath: "/tmp/qr.png", size: 2000 }],
  });
  page.previewWechatQr();
  assert.equal(page.data.wechatQr.localPath, "/tmp/qr.png");
  assert.deepEqual(plain(calls.previews.at(-1)), {
    current: "/tmp/qr.png",
    urls: ["/tmp/qr.png"],
  });
});

await test("store images support preview, reordering and deletion", async () => {
  const { page, calls } = loadContactAdminPage({
    draft: {
      item: {
        storeImageFileIds: [
          "cloud://env/a.jpg",
          "cloud://env/b.jpg",
          "cloud://env/c.jpg",
        ],
        storeImageUrls: [
          "https://example.com/a.jpg",
          "https://example.com/b.jpg",
          "https://example.com/c.jpg",
        ],
        phoneNumbers: [],
      },
    },
  });
  await page.onLoad();

  page.previewStoreImage({ currentTarget: { dataset: { index: 1 } } });
  assert.equal(calls.previews.at(-1).current, "https://example.com/b.jpg");

  page.moveStoreImage({
    currentTarget: { dataset: { index: 2, direction: "left" } },
  });
  assert.deepEqual(
    plain(page.data.storeImages.map((image) => image.fileID)),
    ["cloud://env/a.jpg", "cloud://env/c.jpg", "cloud://env/b.jpg"]
  );

  page.removeStoreImage({ currentTarget: { dataset: { index: 1 } } });
  assert.deepEqual(
    plain(page.data.storeImages.map((image) => image.fileID)),
    ["cloud://env/a.jpg", "cloud://env/b.jpg"]
  );
});

await test("save uploads pending assets with concurrency two and sends ordered config", async () => {
  const { page, calls } = loadContactAdminPage({
    draft: {
      item: {
        storeImageFileIds: ["cloud://env/existing.jpg"],
        storeImageUrls: ["https://example.com/existing.jpg"],
        phoneNumbers: ["", ""],
        revision: 7,
      },
    },
  });
  await page.onLoad();
  page.data.storeImages = page.data.storeImages.concat([
    {
      key: "store-local-a",
      fileID: "",
      url: "/tmp/store-a.jpg",
      localPath: "/tmp/store-a.jpg",
      isPending: true,
    },
    {
      key: "store-local-b",
      fileID: "",
      url: "/tmp/store-b.png",
      localPath: "/tmp/store-b.png",
      isPending: true,
    },
  ]);
  page.data.wechatQr = {
    key: "wechat-local",
    fileID: "",
    url: "/tmp/qr.png",
    localPath: "/tmp/qr.png",
    isPending: true,
  };
  page.data.phoneNumbers = ["+86（188）1234-5678", "0851-12345678"];

  await page.saveContact();

  assert.equal(calls.uploads.length, 3);
  assert.equal(calls.maxConcurrentUploads, 2);
  assert.match(calls.uploads[0].cloudPath, /^contact-assets\/store\//);
  assert.match(calls.uploads[1].cloudPath, /^contact-assets\/store\//);
  assert.match(calls.uploads[2].cloudPath, /^contact-assets\/wechat\//);
  assert.equal(calls.saves.length, 1);
  assert.deepEqual(plain(calls.saves[0]), {
    contact: {
      storeImageFileIds: [
        "cloud://env/existing.jpg",
        "cloud://env/new-0.jpg",
        "cloud://env/new-1.jpg",
      ],
      wechatQrFileId: "cloud://env/new-2.jpg",
      phoneNumbers: ["+86（188）1234-5678", "0851-12345678"],
    },
    revision: 7,
  });
  assert.equal(calls.accessChecks, 2);
  assert.equal(calls.cleanups.length, 0);
  assert.equal(calls.navigateBack, 1);
});

await test("partial upload failure cleans every successfully uploaded file", async () => {
  const { page, calls } = loadContactAdminPage({
    uploadFailureIndex: 1,
    draft: {
      item: {
        storeImageFileIds: [],
        phoneNumbers: [],
        revision: 1,
      },
    },
  });
  await page.onLoad();
  page.data.storeImages = [0, 1, 2].map((index) => ({
    key: `pending-${index}`,
    fileID: "",
    url: `/tmp/${index}.jpg`,
    localPath: `/tmp/${index}.jpg`,
    isPending: true,
  }));

  await page.saveContact();

  assert.equal(calls.saves.length, 0);
  assert.deepEqual(plain(calls.cleanups), [
    ["cloud://env/new-0.jpg", "cloud://env/new-2.jpg"],
  ]);
  assert.equal(page.data.saving, false);
  assert.match(page.data.inlineMessage, /upload failed/);
});

await test("save failure cleans this round of uploads and keeps the editor open", async () => {
  const saveError = new Error("save failed");
  const { page, calls } = loadContactAdminPage({
    saveError,
    draft: {
      item: {
        storeImageFileIds: [],
        phoneNumbers: [],
        revision: 1,
      },
    },
  });
  await page.onLoad();
  page.data.storeImages = [
    {
      key: "pending",
      fileID: "",
      url: "/tmp/store.jpg",
      localPath: "/tmp/store.jpg",
      isPending: true,
    },
  ];

  await page.saveContact();

  assert.deepEqual(plain(calls.cleanups), [["cloud://env/new-0.jpg"]]);
  assert.equal(page.data.saving, false);
  assert.equal(page.data.inlineMessage, "save failed");
  assert.equal(calls.navigateBack, 0);
});

await test("saving state prevents duplicate submissions", async () => {
  const { page, calls, saveDeferred } = loadContactAdminPage({
    deferSave: true,
  });
  await page.onLoad();

  const firstSave = page.saveContact();
  await Promise.resolve();
  await Promise.resolve();
  const duplicateSave = page.saveContact();
  await duplicateSave;

  assert.equal(calls.saves.length, 1);
  saveDeferred.resolve();
  await firstSave;
  assert.equal(calls.navigateBack, 1);
});

await test("editor markup uses native button, input and image components", () => {
  const wxml = readFileSync(wxmlPath, "utf8");
  assert.match(wxml, /<button[\s>]/);
  assert.match(wxml, /<input[\s>]/);
  assert.match(wxml, /<image[\s>]/);
  assert.match(wxml, /bindtap="chooseStoreImages"/);
  assert.match(wxml, /bindtap="chooseWechatQr"/);
  assert.match(wxml, /bindtap="saveContact"/);
  assert.match(wxml, /bindinput="onPhoneInput"/);
  assert.match(wxml, /show-menu-by-longpress="\{\{true\}\}"/);
});
