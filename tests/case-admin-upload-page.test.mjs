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
    activeUploads: 0,
    maxConcurrentUploads: 0,
    mediaPickerCounts: [],
    variantRequests: [],
    activeVariantRequests: 0,
    maxConcurrentVariantRequests: 0,
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
          CASE_ADMIN_GALLERY_MAX: 9,
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
            const callNumber = calls.variantRequests.length + 1;
            calls.variantRequests.push(fileIDs);
            calls.activeVariantRequests += 1;
            calls.maxConcurrentVariantRequests = Math.max(
              calls.maxConcurrentVariantRequests,
              calls.activeVariantRequests
            );
            try {
              await Promise.resolve();
              if (
                options.variantError ||
                options.variantFailureCall === callNumber
              ) {
                throw options.variantError || new Error("variant batch failed");
              }
              const variants = options.variants || fileIDs.map((fileID, index) => {
                const sourceMatch = /source-(\d+)\.jpg$/.exec(fileID);
                const variantIndex = sourceMatch
                  ? Number(sourceMatch[1]) - 1
                  : index;
                return {
                  sourceFileID: fileID,
                  displayFileID: `cloud://env/display-${variantIndex}.jpg`,
                  thumbnailFileID: `cloud://env/thumbnail-${variantIndex}.jpg`,
                  bannerFileID: `cloud://env/banner-${variantIndex}.jpg`,
                  variantVersion: 2,
                };
              });
              return options.reverseVariants ? variants.reverse() : variants;
            } finally {
              calls.activeVariantRequests -= 1;
            }
          },
          updateCaseAdmin: async () => ({}),
          uploadCaseCoverImage: async ({ filePath }) => {
            calls.uploads.push(filePath);
            const uploadIndex = calls.uploads.length;
            calls.activeUploads += 1;
            calls.maxConcurrentUploads = Math.max(
              calls.maxConcurrentUploads,
              calls.activeUploads
            );
            try {
              await Promise.resolve();
              if (options.uploadError) throw options.uploadError;
              return `cloud://env/source-${uploadIndex}.jpg`;
            } finally {
              calls.activeUploads -= 1;
            }
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
      chooseMedia(options) {
        calls.mediaPickerCounts.push(options.count);
      },
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

await test("one case accepts up to nine selected images with bounded concurrency", async () => {
  const { page, calls } = loadCaseEditPage();
  const selectedPaths = Array.from(
    { length: 10 },
    (_, index) => `/tmp/source-${index}.jpg`
  );

  await page.uploadGalleryImages(selectedPaths);

  assert.equal(calls.uploads.length, 9);
  assert.equal(calls.maxConcurrentUploads, 3);
  assert.equal(calls.variantRequests.length, 3);
  assert.deepEqual(
    calls.variantRequests.map((fileIDs) => fileIDs.length),
    [3, 3, 3]
  );
  assert.equal(calls.maxConcurrentVariantRequests, 3);
  assert.equal(page.data.form.galleryImages.length, 9);
  assert.equal(page.data.form.sourceGalleryImages.length, 9);
  assert.equal(page.data.form.galleryThumbnails.length, 9);
  assert.equal(page.data.form.galleryBanners.length, 9);
  assert.equal(calls.toasts.at(-1).title, "已上传 9 张");
});

await test("variant results are aligned back to the original selection order", async () => {
  const { page } = loadCaseEditPage({ reverseVariants: true });

  await page.uploadGalleryImages([
    "/tmp/source-a.jpg",
    "/tmp/source-b.jpg",
    "/tmp/source-c.jpg",
  ]);

  assert.deepEqual(JSON.parse(JSON.stringify(page.data.form.galleryImages)), [
    "cloud://env/display-0.jpg",
    "cloud://env/display-1.jpg",
    "cloud://env/display-2.jpg",
  ]);
});

await test("the media picker accepts nine images at once and only the remaining slot later", async () => {
  const { page, calls } = loadCaseEditPage();

  page.chooseGalleryImages();
  page.data.form.galleryImages = Array.from(
    { length: 8 },
    (_, index) => `cloud://env/display-${index}.jpg`
  );
  page.chooseGalleryImages();

  assert.deepEqual(calls.mediaPickerCounts, [9, 1]);
});

await test("a later processing batch failure cleans originals and completed variants", async () => {
  const { page, calls } = loadCaseEditPage({ variantFailureCall: 2 });
  const selectedPaths = Array.from(
    { length: 9 },
    (_, index) => `/tmp/source-${index}.jpg`
  );

  await page.uploadGalleryImages(selectedPaths);

  assert.deepEqual(JSON.parse(JSON.stringify(page.data.form.galleryImages)), []);
  assert.equal(calls.variantRequests.length, 3);
  assert.equal(calls.cleanupRequests.length, 1);
  assert.equal(calls.cleanupRequests[0].length, 27);
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.cleanupRequests[0].slice(0, 9))),
    [
      "cloud://env/source-1.jpg",
      "cloud://env/source-2.jpg",
      "cloud://env/source-3.jpg",
      "cloud://env/source-4.jpg",
      "cloud://env/source-5.jpg",
      "cloud://env/source-6.jpg",
      "cloud://env/source-7.jpg",
      "cloud://env/source-8.jpg",
      "cloud://env/source-9.jpg",
    ]
  );
  assert.equal(page.data.imageProcessingFailed, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(page.data.pendingImagePaths)),
    selectedPaths
  );
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
    "cloud://env/display-1.jpg",
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
