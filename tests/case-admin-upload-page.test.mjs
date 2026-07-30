import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pagePath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/case-admin/edit.js"
);

function loadCaseEditPage(options = {}) {
  let page;
  const calls = {
    toasts: [],
    warnings: [],
    uploads: [],
    variantRequests: [],
    cleanupRequests: [],
  };
  const initialForm = {
    title: "",
    caseId: "",
    coverImage: "",
    coverThumbnail: "",
    coverBanner: "",
    galleryImages: [],
    sourceGalleryImages: [],
    galleryThumbnails: [],
    galleryBanners: [],
    imageVariantVersion: 2,
    wineType: "白酒",
    packageTypes: [],
    styles: [],
    priceLevel: "",
    scenes: [],
    statuses: [],
    homeSections: [],
    sortOrder: "",
    notes: "",
    isVisible: false,
    isPinned: false,
  };
  const sandbox = {
    Page(config) {
      page = config;
    },
    require(moduleName) {
      if (moduleName === "./utils/caseAdminData") {
        return {
          CASE_ADMIN_FORM_OPTIONS: {},
          buildCaseAdminImagePath: (filePath) => `uploads/${filePath.split("/").pop()}`,
          buildCaseAdminOptionViews: () => ({}),
          buildCaseAdminPayload: (form) => form,
          createEmptyCaseForm: () => ({ ...initialForm }),
          CASE_ADMIN_GALLERY_MAX: 5,
          validateCaseAdminForm: () => ({ valid: true }),
        };
      }
      if (moduleName === "./utils/caseAdminService") {
        return {
          createCaseAdmin: async () => ({}),
          cleanupUnreferencedFiles: async (fileIDs) => {
            calls.cleanupRequests.push(fileIDs);
            return fileIDs;
          },
          fetchCaseAdminDetail: async () => null,
          generateCaseImageVariants: async (fileIDs) => {
            calls.variantRequests.push(fileIDs);
            if (options.variantError) throw options.variantError;
            return options.variants || fileIDs.map((fileID, index) => ({
              sourceFileID: fileID,
              displayFileID: `cloud://env/display-${index}.jpg`,
              thumbnailFileID: `cloud://env/thumbnail-${index}.jpg`,
              bannerFileID: `cloud://env/banner-${index}.jpg`,
              variantVersion: 2,
            }));
          },
          updateCaseAdmin: async () => ({}),
          uploadCaseCoverImage: async ({ filePath }) => {
            calls.uploads.push(filePath);
            if (options.uploadError) throw options.uploadError;
            return `cloud://env/source-${calls.uploads.length}.jpg`;
          },
        };
      }
      if (moduleName === "./utils/notificationAdminService") {
        return {
          publishProductAnnouncement: async () => ({}),
        };
      }
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
    },
    wx: {
      showToast(toast) {
        calls.toasts.push(toast);
      },
      navigateBack() {},
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

await test("successful image processing keeps all v2 image variants", async () => {
  const { page, calls } = loadCaseEditPage();

  await page.uploadGalleryImages(["/tmp/source-a.jpg"]);

  assert.deepEqual(JSON.parse(JSON.stringify(page.data.form.sourceGalleryImages)), [
    "cloud://env/source-1.jpg",
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(page.data.form.galleryImages)), [
    "cloud://env/display-0.jpg",
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(page.data.form.galleryThumbnails)), [
    "cloud://env/thumbnail-0.jpg",
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(page.data.form.galleryBanners)), [
    "cloud://env/banner-0.jpg",
  ]);
  assert.equal(page.data.form.coverBanner, "cloud://env/banner-0.jpg");
  assert.equal(page.data.form.imageVariantVersion, 2);
  assert.equal(page.data.uploading, false);
  assert.equal(page.data.imageProcessingFailed, false);
  assert.equal(calls.toasts.at(-1).title, "已上传 1 张");
});

await test("image processor failures keep the form unchanged and clean uploaded originals", async () => {
  const error = new Error("无权限处理案例图片");
  error.code = "FORBIDDEN";
  const { page, calls } = loadCaseEditPage({ variantError: error });

  await page.uploadGalleryImages(["/tmp/source-a.jpg"]);

  assert.deepEqual(JSON.parse(JSON.stringify(page.data.form.sourceGalleryImages)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(page.data.form.galleryImages)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(page.data.form.galleryThumbnails)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(page.data.form.galleryBanners)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.cleanupRequests)), [
    ["cloud://env/source-1.jpg"],
  ]);
  assert.equal(page.data.uploading, false);
  assert.equal(page.data.imageProcessingFailed, true);
  assert.deepEqual(JSON.parse(JSON.stringify(page.data.pendingImagePaths)), [
    "/tmp/source-a.jpg",
  ]);
  assert.equal(calls.toasts.at(-1).title, "图片处理失败，请重试");
  await page.saveCase();
  assert.equal(calls.toasts.at(-1).title, "请先完成图片处理");
});

await test("retry reuses local paths and only updates the form after success", async () => {
  const options = { variantError: new Error("cloud function timeout") };
  const { page } = loadCaseEditPage(options);
  await page.uploadGalleryImages(["/tmp/source-b.jpg"]);
  options.variantError = null;
  await page.retryImageProcessing();

  assert.deepEqual(JSON.parse(JSON.stringify(page.data.form.galleryImages)), [
    "cloud://env/display-0.jpg",
  ]);
  assert.equal(page.data.imageProcessingFailed, false);
  assert.deepEqual(JSON.parse(JSON.stringify(page.data.pendingImagePaths)), []);
});

await test("raw upload failures still show the existing retry error", async () => {
  const { page, calls } = loadCaseEditPage({
    uploadError: new Error("upload failed"),
  });

  await page.uploadGalleryImages(["/tmp/source-a.jpg"]);

  assert.deepEqual(JSON.parse(JSON.stringify(page.data.form.galleryImages)), []);
  assert.equal(page.data.uploading, false);
  assert.equal(page.data.topTips.message, "图片处理失败，请重试");
  assert.equal(page.data.imageProcessingFailed, true);
  assert.equal(calls.toasts.at(-1).title, "图片处理失败，请重试");
});
