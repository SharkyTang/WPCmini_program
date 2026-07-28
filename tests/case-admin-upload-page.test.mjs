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
  };
  const initialForm = {
    title: "",
    caseId: "",
    coverImage: "",
    coverThumbnail: "",
    galleryImages: [],
    sourceGalleryImages: [],
    galleryThumbnails: [],
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
          fetchCaseAdminDetail: async () => null,
          generateCaseImageVariants: async (fileIDs) => {
            calls.variantRequests.push(fileIDs);
            if (options.variantError) throw options.variantError;
            return options.variants || fileIDs.map((fileID, index) => ({
              sourceFileID: fileID,
              displayFileID: `cloud://env/display-${index}.jpg`,
              thumbnailFileID: `cloud://env/thumbnail-${index}.jpg`,
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

await test("successful image processing keeps optimized display and thumbnail files", async () => {
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
  assert.equal(page.data.uploading, false);
  assert.equal(calls.toasts.at(-1).title, "已上传 1 张");
});

await test("image processor failures retain uploaded originals and allow saving", async () => {
  const error = new Error("无权限处理案例图片");
  error.code = "FORBIDDEN";
  const { page, calls } = loadCaseEditPage({ variantError: error });

  await page.uploadGalleryImages(["/tmp/source-a.jpg"]);

  assert.deepEqual(JSON.parse(JSON.stringify(page.data.form.sourceGalleryImages)), [
    "cloud://env/source-1.jpg",
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(page.data.form.galleryImages)), [
    "cloud://env/source-1.jpg",
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(page.data.form.galleryThumbnails)), [
    "cloud://env/source-1.jpg",
  ]);
  assert.equal(page.data.form.coverImage, "cloud://env/source-1.jpg");
  assert.equal(page.data.form.coverThumbnail, "cloud://env/source-1.jpg");
  assert.equal(page.data.uploading, false);
  assert.equal(calls.toasts.at(-1).title, "原图已上传");
  assert.equal(calls.warnings[0][0], "图片变体处理失败，已使用原图继续保存");
});

await test("fallback keeps legacy gallery arrays aligned when adding an image", async () => {
  const { page } = loadCaseEditPage({
    variantError: new Error("cloud function timeout"),
  });
  page.setData({
    form: {
      ...page.data.form,
      coverImage: "cloud://env/legacy.jpg",
      galleryImages: ["cloud://env/legacy.jpg"],
      sourceGalleryImages: [],
      galleryThumbnails: [],
    },
    galleryPreviewUrls: ["cloud://env/legacy.jpg"],
  });

  await page.uploadGalleryImages(["/tmp/source-b.jpg"]);

  assert.deepEqual(JSON.parse(JSON.stringify(page.data.form.sourceGalleryImages)), [
    "cloud://env/legacy.jpg",
    "cloud://env/source-1.jpg",
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(page.data.form.galleryThumbnails)), [
    "cloud://env/legacy.jpg",
    "cloud://env/source-1.jpg",
  ]);
  assert.equal(
    page.data.form.galleryThumbnails.length,
    page.data.form.galleryImages.length
  );
});

await test("raw upload failures still show the existing retry error", async () => {
  const { page, calls } = loadCaseEditPage({
    uploadError: new Error("upload failed"),
  });

  await page.uploadGalleryImages(["/tmp/source-a.jpg"]);

  assert.deepEqual(JSON.parse(JSON.stringify(page.data.form.galleryImages)), []);
  assert.equal(page.data.uploading, false);
  assert.equal(page.data.topTips.message, "图片上传失败，请重新选择一张图片");
  assert.equal(calls.toasts.at(-1).title, "图片上传失败");
});
