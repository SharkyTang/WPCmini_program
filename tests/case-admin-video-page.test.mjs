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
const wxmlPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/case-admin/edit.wxml"
);
const caseDataPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/utils/caseData.js"
);
const caseAdminDataPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/case-admin/utils/caseAdminData.js"
);

function loadCommonJsModule(modulePath, dependencies = {}) {
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require(moduleName) {
      if (dependencies[moduleName]) return dependencies[moduleName];
      throw new Error(`Unexpected require: ${moduleName}`);
    },
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(readFileSync(modulePath, "utf8"), sandbox, {
    filename: modulePath,
  });
  return sandbox.module.exports;
}

const caseData = loadCommonJsModule(caseDataPath);
const dataUtils = loadCommonJsModule(caseAdminDataPath, {
  "../../../utils/caseData": caseData,
});

function buildCase(overrides = {}) {
  return {
    id: "case_doc_1",
    caseId: "case_001",
    version: 7,
    title: "红色礼盒",
    coverImage: "cloud://env/display.jpg",
    coverImageUrl: "https://temp.example.com/display.jpg",
    galleryImages: ["cloud://env/display.jpg"],
    sourceGalleryImages: ["cloud://env/source.jpg"],
    galleryThumbnails: ["cloud://env/thumb.jpg"],
    galleryBanners: ["cloud://env/banner.jpg"],
    galleryImageUrls: ["https://temp.example.com/display.jpg"],
    imageVariantVersion: 2,
    wineType: "白酒",
    packageTypes: ["礼盒"],
    styles: [],
    priceLevel: "品质款",
    scenes: [],
    statuses: [],
    homeSections: [],
    sortOrder: 10,
    notes: "",
    isVisible: false,
    isPinned: false,
    ...overrides,
  };
}

function loadVideoPage(options = {}) {
  let page;
  let uploadCount = 0;
  let detailFetchCount = 0;
  const calls = {
    chooseMedia: [],
    prepare: [],
    uploads: [],
    updates: [],
    cleanup: [],
    toasts: [],
    alertsEnabled: [],
    alertsDisabled: 0,
    videoInfoRequests: [],
    warnings: [],
    navigations: 0,
  };
  const caseItem = buildCase(options.caseItem);
  const sandbox = {
    Page(config) {
      page = config;
    },
    require(moduleName) {
      if (moduleName === "./utils/caseAdminData") return dataUtils;
      if (moduleName === "./utils/caseAdminService") {
        return {
          createCaseAdmin: async () => ({ id: "new_case" }),
          cleanupUnreferencedFiles: async (fileIDs) => {
            calls.cleanup.push([...fileIDs]);
            if (options.cleanupError) throw new Error("cleanup failed");
            if (options.cleanupResult) return options.cleanupResult;
            return fileIDs;
          },
          fetchCaseAdminConfig: async () => ({
            features: { videoUploadEnabled: options.videoUploadEnabled !== false },
            limits: {
              videoUploadBytes: 104857600,
              videoDurationSeconds: 120,
              videoPosterUploadBytes: 5242880,
            },
          }),
          fetchCaseAdminDetail: async () => {
            detailFetchCount += 1;
            if (detailFetchCount > 1 && options.conflictCaseItem) {
              return buildCase(options.conflictCaseItem);
            }
            return caseItem;
          },
          generateCaseImageVariants: async () => [],
          prepareCaseVideoUpload: async (request) => {
            calls.prepare.push({ ...request });
            if (options.deferredPrepare) {
              return new Promise((resolvePrepare) => {
                calls.resolvePrepare = resolvePrepare;
              });
            }
            return {
              cloudPath: `wine-packaging/videos/grant/${request.kind}-${calls.prepare.length}.${
                request.kind === "video" ? "mp4" : "jpg"
              }`,
            };
          },
          updateCaseAdmin: async (id, payload, updateOptions) => {
            calls.updates.push({ id, payload, options: updateOptions });
            if (options.deferredUpdate) {
              return new Promise((resolveUpdate, rejectUpdate) => {
                calls.resolveUpdate = resolveUpdate;
                calls.rejectUpdate = rejectUpdate;
              });
            }
            if (options.updateError) throw options.updateError;
            return { version: 8 };
          },
          uploadCaseCoverImage: async () => "cloud://env/source.jpg",
          uploadCaseVideoMedia: async (request) => {
            uploadCount += 1;
            calls.uploads.push(request);
            const task = { abort() {} };
            request.onTask(task);
            request.onProgress(35);
            if (options.uploadFailures && uploadCount <= options.uploadFailures) {
              throw new Error("upload failed");
            }
            request.onProgress(100);
            return request.cloudPath.includes("poster")
              ? `cloud://env/${request.cloudPath}`
              : `cloud://env/${request.cloudPath}`;
          },
        };
      }
      if (moduleName === "./utils/notificationAdminService") {
        return { publishProductAnnouncement: async () => ({}) };
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
      chooseMedia(request) {
        calls.chooseMedia.push(request);
      },
      getVideoInfo(request) {
        calls.videoInfoRequests.push(request);
        if (options.deferredVideoMetadata) return;
        request.success(options.videoMetadata || {
          duration: 61.2,
          width: 1920,
          height: 1080,
        });
      },
      enableAlertBeforeUnload(request) {
        calls.alertsEnabled.push(request);
      },
      disableAlertBeforeUnload() {
        calls.alertsDisabled += 1;
      },
      showToast(request) {
        calls.toasts.push(request);
      },
      showModal() {},
      navigateBack() {
        calls.navigations += 1;
      },
    },
  };

  vm.runInNewContext(readFileSync(pagePath, "utf8"), sandbox, {
    filename: pagePath,
  });
  page.setData = function setData(nextData) {
    this.data = { ...this.data, ...nextData };
  };
  return { page, calls, caseItem };
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

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

await test("video controls are edit-only and use album pickers", async () => {
  const wxml = readFileSync(wxmlPath, "utf8");
  const { page, calls } = loadVideoPage();
  await page.loadCase("case_doc_1");

  assert.equal(wxml.includes('wx:if="{{isEdit}}"'), true);
  assert.equal(wxml.includes("展示视频"), true);
  assert.equal(wxml.includes("高级设置 · HTTPS 外链"), true);
  page.chooseCaseVideo();
  page.chooseVideoPoster();
  assert.deepEqual(plain(calls.chooseMedia[0].mediaType), ["video"]);
  assert.deepEqual(plain(calls.chooseMedia[0].sourceType), ["album"]);
  assert.equal(Object.hasOwn(calls.chooseMedia[0], "maxDuration"), false);
});

await test("loads existing cloud video previews and server limits", async () => {
  const { page } = loadVideoPage({
    caseItem: {
      videoFileID: "cloud://env/wine-packaging/videos/existing.mp4",
      videoPreviewUrl: "https://temp.example.com/existing.mp4",
      videoPosterFileID: "cloud://env/wine-packaging/videos/poster.jpg",
      videoPosterPreviewUrl: "https://temp.example.com/poster.jpg",
      videoDurationSeconds: 45,
      videoFileSizeBytes: 10485760,
    },
  });

  await page.loadCase("case_doc_1");

  assert.equal(page.data.videoUploadEnabled, true);
  assert.equal(page.data.videoSource, "upload");
  assert.equal(page.data.videoDraft.uploadPreviewUrl, "https://temp.example.com/existing.mp4");
  assert.equal(page.data.videoDraft.uploadPosterPreviewUrl, "https://temp.example.com/poster.jpg");
  assert.equal(page.data.videoLimits.videoUploadBytes, 104857600);
  assert.equal(page.data.videoFileSizeLabel, "10.0MB");
});

await test("a disabled upload flag keeps HTTPS external editing available", async () => {
  const { page, calls } = loadVideoPage({ videoUploadEnabled: false });
  await page.loadCase("case_doc_1");

  page.chooseCaseVideo();
  assert.equal(calls.chooseMedia.length, 0);
  assert.equal(calls.toasts.at(-1).title, "云视频上传暂未开启，可使用 HTTPS 外链");

  await page.onVideoSourceSelect({ currentTarget: { dataset: { source: "external" } } });
  page.onExternalVideoUrlInput({ detail: { value: "https://cdn.example.com/fallback.mp4" } });
  await page.saveCase();

  assert.equal(calls.updates[0].options.videoPatch.mode, "external");
  assert.equal(calls.updates[0].options.videoPatch.url, "https://cdn.example.com/fallback.mp4");
});

await test("uploads a validated MP4 with progress then saves one atomic patch", async () => {
  const { page, calls } = loadVideoPage();
  await page.loadCase("case_doc_1");

  await page.handleSelectedVideo({
    tempFilePath: "/tmp/showcase.mp4",
    size: 20 * 1024 * 1024,
    mimeType: "video/mp4",
  });

  assert.deepEqual(plain(calls.prepare[0]), {
    id: "case_doc_1",
    kind: "video",
    fileName: "showcase.mp4",
  });
  assert.equal(page.data.videoUploadProgress, 100);
  assert.equal(page.data.videoDraft.uploadDurationSeconds, 62);
  assert.equal(page.data.pendingVideoFileIDs.length, 1);
  assert.equal(calls.alertsEnabled.length > 0, true);

  await page.saveCase();

  assert.equal(calls.updates.length, 1);
  assert.deepEqual(plain(calls.updates[0].options), {
    videoPatch: {
      mode: "upload",
      fileID: page.data.videoDraft.uploadFileID,
      durationSeconds: 62,
      posterFileID: "",
    },
    expectedVersion: 7,
  });
  assert.deepEqual(plain(page.data.pendingVideoFileIDs), []);
  assert.equal(calls.alertsDisabled > 0, true);
  assert.equal(calls.navigations, 1);
});

await test("failed video uploads retain the local selection for retry", async () => {
  const { page, calls } = loadVideoPage({ uploadFailures: 1 });
  await page.loadCase("case_doc_1");

  await page.handleSelectedVideo({
    tempFilePath: "/tmp/retry.mp4",
    size: 10 * 1024 * 1024,
    mimeType: "video/mp4",
  });
  assert.equal(page.data.videoUploadError, "视频上传失败，请重试");

  await page.retryVideoUpload();
  assert.equal(calls.uploads.length, 2);
  assert.equal(page.data.videoUploadError, "");
  assert.equal(page.data.videoDraft.uploadFileID.startsWith("cloud://"), true);
  const warningText = JSON.stringify(calls.warnings);
  assert.equal(warningText.includes("video_upload"), true);
  assert.equal(warningText.includes("/tmp/retry.mp4"), false);
  assert.equal(warningText.includes("cloud://"), false);
});

await test("uploads an optional poster and includes it in the upload patch", async () => {
  const { page, calls } = loadVideoPage();
  await page.loadCase("case_doc_1");
  await page.handleSelectedVideo({
    tempFilePath: "/tmp/showcase.mp4",
    size: 1024,
    mimeType: "video/mp4",
  });
  await page.handleSelectedVideoPoster({
    tempFilePath: "/tmp/poster.webp",
    size: 1024,
    mimeType: "image/webp",
  });
  await page.saveCase();

  assert.equal(calls.prepare[1].kind, "poster");
  assert.equal(page.data.videoDraft.uploadPosterPreviewUrl, "/tmp/poster.webp");
  assert.equal(calls.updates[0].options.videoPatch.posterFileID.startsWith("cloud://"), true);
});

await test("advanced HTTPS fields save an external patch without cloud upload", async () => {
  const { page, calls } = loadVideoPage();
  await page.loadCase("case_doc_1");
  await page.onVideoSourceSelect({ currentTarget: { dataset: { source: "external" } } });
  page.onExternalVideoUrlInput({ detail: { value: "https://cdn.example.com/case.mp4" } });
  page.onExternalPosterUrlInput({ detail: { value: "https://cdn.example.com/poster.jpg" } });
  page.onExternalDurationInput({ detail: { value: "90" } });

  await page.saveCase();

  assert.equal(calls.uploads.length, 0);
  assert.deepEqual(plain(calls.updates[0].options.videoPatch), {
    mode: "external",
    url: "https://cdn.example.com/case.mp4",
    durationSeconds: 90,
    posterUrl: "https://cdn.example.com/poster.jpg",
  });
});

await test("legacy cases without a stored version send version one with a video patch", async () => {
  const { page, calls } = loadVideoPage({
    caseItem: {
      version: undefined,
    },
  });
  await page.loadCase("case_doc_1");
  await page.onVideoSourceSelect({ currentTarget: { dataset: { source: "external" } } });
  page.onExternalVideoUrlInput({ detail: { value: "https://cdn.example.com/legacy.mp4" } });

  await page.saveCase();

  assert.equal(calls.updates[0].options.expectedVersion, 1);
  assert.equal(calls.updates[0].options.videoPatch.mode, "external");
});

await test("removing an unsaved upload cleans it and saves an explicit clear patch", async () => {
  const { page, calls } = loadVideoPage();
  await page.loadCase("case_doc_1");
  await page.handleSelectedVideo({
    tempFilePath: "/tmp/remove.mp4",
    size: 1024,
    mimeType: "video/mp4",
  });
  const pendingFileID = page.data.videoDraft.uploadFileID;

  await page.removeCaseVideo();
  await page.saveCase();

  assert.deepEqual(plain(calls.cleanup[0]), [pendingFileID]);
  assert.deepEqual(plain(calls.updates[0].options.videoPatch), { mode: "clear" });
});

await test("saving is blocked during upload and unloading aborts and cleans pending files", async () => {
  const { page, calls } = loadVideoPage();
  await page.loadCase("case_doc_1");
  let abortCount = 0;
  page.activeVideoUploadTask = { abort() { abortCount += 1; } };
  page.setData({
    videoUploading: true,
    pendingVideoFileIDs: ["cloud://env/wine-packaging/videos/pending.mp4"],
  });

  await page.saveCase();
  assert.equal(calls.updates.length, 0);
  assert.equal(calls.toasts.at(-1).title, "请等待上传完成");

  page.onUnload();
  await Promise.resolve();
  assert.equal(abortCount, 1);
  assert.deepEqual(plain(calls.cleanup.at(-1)), [
    "cloud://env/wine-packaging/videos/pending.mp4",
  ]);
});

await test("a deferred save locks video actions and never deletes files being bound", async () => {
  const wxml = readFileSync(wxmlPath, "utf8");
  const { page, calls } = loadVideoPage({ deferredUpdate: true });
  await page.loadCase("case_doc_1");
  await page.handleSelectedVideo({
    tempFilePath: "/tmp/deferred.mp4",
    size: 2048,
    mimeType: "video/mp4",
  });
  const pendingFileID = page.data.videoDraft.uploadFileID;
  const uploadCountBeforeSave = calls.uploads.length;
  const pickerCountBeforeSave = calls.chooseMedia.length;

  const savePromise = page.saveCase();
  await Promise.resolve();
  assert.equal(page.data.saving, true);
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.alertsEnabled.length > 0, true);

  await page.onVideoSourceSelect({
    currentTarget: { dataset: { source: "external" } },
  });
  page.chooseCaseVideo();
  await page.retryVideoUpload();
  await page.removeCaseVideo();
  await page.saveCase();

  assert.equal(page.data.videoSource, "upload");
  assert.equal(page.data.videoDraft.uploadFileID, pendingFileID);
  assert.equal(calls.chooseMedia.length, pickerCountBeforeSave);
  assert.equal(calls.uploads.length, uploadCountBeforeSave);
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.cleanup.length, 0);
  assert.equal(wxml.includes("saving || !videoUploadEnabled"), true);
  assert.equal(wxml.includes('disabled="{{saving}}"'), true);

  page.onUnload();
  await Promise.resolve();
  assert.equal(calls.cleanup.length, 0);

  calls.resolveUpdate({ version: 8 });
  await savePromise;
  assert.equal(calls.cleanup.length, 0);
  assert.equal(calls.navigations, 0);
});

await test("a deferred save failure cleans pending files only after the request settles", async () => {
  const { page, calls } = loadVideoPage({ deferredUpdate: true });
  await page.loadCase("case_doc_1");
  await page.handleSelectedVideo({
    tempFilePath: "/tmp/deferred-failure.mp4",
    size: 4096,
    mimeType: "video/mp4",
  });
  const pendingFileID = page.data.videoDraft.uploadFileID;

  const savePromise = page.saveCase();
  await Promise.resolve();
  page.onUnload();
  await Promise.resolve();
  assert.equal(calls.cleanup.length, 0);

  calls.rejectUpdate(new Error("save failed"));
  await savePromise;

  assert.deepEqual(plain(calls.cleanup), [[pendingFileID]]);
  assert.equal(calls.navigations, 0);
});

await test("late picker and metadata callbacks cannot start uploads after unload", async () => {
  const pickerCase = loadVideoPage();
  await pickerCase.page.loadCase("case_doc_1");
  pickerCase.page.chooseCaseVideo();
  const pickerRequest = pickerCase.calls.chooseMedia[0];
  pickerCase.page.onUnload();
  await pickerRequest.success({
    tempFiles: [{
      tempFilePath: "/tmp/late-picker.mp4",
      size: 1024,
      mimeType: "video/mp4",
    }],
  });
  assert.equal(pickerCase.calls.videoInfoRequests.length, 0);
  assert.equal(pickerCase.calls.uploads.length, 0);

  const metadataCase = loadVideoPage({ deferredVideoMetadata: true });
  await metadataCase.page.loadCase("case_doc_1");
  const metadataPromise = metadataCase.page.handleSelectedVideo({
    tempFilePath: "/tmp/late-metadata.mp4",
    size: 1024,
    mimeType: "video/mp4",
  });
  assert.equal(metadataCase.calls.videoInfoRequests.length, 1);
  metadataCase.page.onUnload();
  metadataCase.calls.videoInfoRequests[0].success({
    duration: 30,
    width: 1920,
    height: 1080,
  });
  await metadataPromise;
  assert.equal(metadataCase.calls.prepare.length, 0);
  assert.equal(metadataCase.calls.uploads.length, 0);

  const posterCase = loadVideoPage({
    caseItem: {
      videoFileID: "cloud://env/wine-packaging/videos/existing.mp4",
      videoPreviewUrl: "https://temp.example.com/existing.mp4",
      videoDurationSeconds: 30,
    },
  });
  await posterCase.page.loadCase("case_doc_1");
  posterCase.page.chooseVideoPoster();
  const posterRequest = posterCase.calls.chooseMedia[0];
  posterCase.page.onUnload();
  await posterRequest.success({
    tempFiles: [{
      tempFilePath: "/tmp/late-poster.jpg",
      size: 1024,
      mimeType: "image/jpeg",
    }],
  });
  assert.equal(posterCase.calls.prepare.length, 0);
  assert.equal(posterCase.calls.uploads.length, 0);
});

await test("unloading while upload preparation is pending never creates an upload task", async () => {
  const { page, calls } = loadVideoPage({ deferredPrepare: true });
  await page.loadCase("case_doc_1");
  const uploadPromise = page.handleSelectedVideo({
    tempFilePath: "/tmp/prepare-race.mp4",
    size: 1024,
    mimeType: "video/mp4",
  });
  await Promise.resolve();
  assert.equal(calls.prepare.length, 1);
  assert.equal(page.data.videoUploading, true);
  assert.equal(calls.alertsEnabled.length > 0, true);

  page.onUnload();
  calls.resolvePrepare({
    cloudPath: "wine-packaging/videos/grant/late.mp4",
  });
  await uploadPromise;

  assert.equal(calls.uploads.length, 0);
});

await test("version conflict refreshes only the baseline and retries with the same draft", async () => {
  const conflict = new Error("conflict");
  conflict.code = "VERSION_CONFLICT";
  conflict.currentVersion = 9;
  const options = {
    updateError: conflict,
    conflictCaseItem: {
      version: 9,
      videoUrl: "https://cdn.example.com/server-latest.mp4",
      videoDurationSeconds: 40,
    },
  };
  const { page, calls } = loadVideoPage(options);
  await page.loadCase("case_doc_1");
  await page.handleSelectedVideo({
    tempFilePath: "/tmp/conflict-draft.mp4",
    size: 2048,
    mimeType: "video/mp4",
  });
  const formBefore = plain(page.data.form);
  const draftBefore = plain(page.data.videoDraft);
  const pendingBefore = plain(page.data.pendingVideoFileIDs);

  await page.saveCase();

  assert.equal(page.caseVersion, 9);
  assert.deepEqual(plain(page.data.form), formBefore);
  assert.deepEqual(plain(page.data.videoDraft), draftBefore);
  assert.deepEqual(plain(page.data.pendingVideoFileIDs), pendingBefore);
  assert.equal(page.initialVideoDraft.externalUrl, "https://cdn.example.com/server-latest.mp4");
  assert.equal(calls.cleanup.length, 0);
  assert.equal(page.data.topTips.message, "案例版本已刷新，当前修改已保留，请再次保存");

  options.updateError = null;
  await page.saveCase();

  assert.equal(calls.updates.length, 2);
  assert.equal(calls.updates[1].options.expectedVersion, 9);
  assert.deepEqual(
    plain(calls.updates[1].options.videoPatch),
    plain(calls.updates[0].options.videoPatch)
  );
  assert.equal(calls.navigations, 1);
});

await test("partial cleanup removes deleted and skipped files but retains failures", async () => {
  const deleted = "cloud://env/wine-packaging/videos/deleted.mp4";
  const skipped = "cloud://env/wine-packaging/videos/skipped.mp4";
  const failed = "cloud://env/wine-packaging/videos/failed.mp4";
  const { page, calls } = loadVideoPage({
    cleanupResult: {
      deletedFileIds: [deleted],
      skippedFileIds: [skipped],
      failedFileIds: [failed],
    },
  });
  await page.loadCase("case_doc_1");
  page.setData({ pendingVideoFileIDs: [deleted, skipped, failed] });

  await page.cleanupPendingVideoFiles([deleted, skipped, failed]);

  assert.deepEqual(plain(page.data.pendingVideoFileIDs), [failed]);
  const warningText = JSON.stringify(calls.warnings);
  assert.equal(warningText.includes("VIDEO_CLEANUP_PARTIAL_FAILURE"), true);
  assert.equal(warningText.includes(deleted), false);
  assert.equal(warningText.includes(failed), false);
});
