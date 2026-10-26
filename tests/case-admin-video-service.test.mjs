import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const servicePath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/case-admin/utils/caseAdminService.js"
);

function loadService(options = {}) {
  const calls = {
    functions: [],
    uploads: [],
    progressHandlers: [],
  };
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console,
    require(moduleName) {
      if (moduleName === "./caseAdminData") {
        return {
          CASE_ADMIN_VIEW_OPTIONS: [],
          CASE_ADMIN_VISIBILITY_OPTIONS: [],
          normalizeCaseAdminItem: (item) => item,
          normalizeCaseAdminHomepageDisplayItem: (item) => item,
          normalizeCaseAdminKeyword: (value) => value || "",
        };
      }
      if (moduleName === "../../../utils/cloudData") {
        return { clearCloudDataCache() {} };
      }
      if (moduleName === "../../../utils/caseRefresh") {
        return { markCaseDataStale() {} };
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    wx: {
      cloud: {
        async callFunction(request) {
          calls.functions.push(request);
          const action = request.data.action;
          if (action === "getAdminConfig") {
            return {
              result: {
                ok: true,
                config: {
                  features: { videoUploadEnabled: true },
                  limits: { videoUploadBytes: 104857600 },
                },
              },
            };
          }
          if (action === "prepareVideoUpload") {
            return {
              result: {
                ok: true,
                cloudPath: "wine-packaging/videos/grant/video.mp4",
              },
            };
          }
          if (action === "updateCase" && options.versionConflict) {
            return {
              result: {
                ok: false,
                code: "VERSION_CONFLICT",
                message: "案例版本冲突",
                currentVersion: 9,
              },
            };
          }
          if (action === "cleanupUnreferencedFiles") {
            return {
              result: {
                ok: true,
                deletedFileIds: [request.data.fileIDs[0]],
                skippedFileIds: [request.data.fileIDs[1]],
                failedFileIds: [request.data.fileIDs[2]],
              },
            };
          }
          return { result: { ok: true, version: 8 } };
        },
        uploadFile(request) {
          calls.uploads.push(request);
          const task = Promise.resolve({
            fileID: "cloud://env/wine-packaging/videos/grant/video.mp4",
          });
          task.onProgressUpdate = (handler) => {
            calls.progressHandlers.push(handler);
            handler({ progress: 47 });
          };
          task.abort = () => {};
          return task;
        },
      },
    },
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(readFileSync(servicePath, "utf8"), sandbox, {
    filename: servicePath,
  });
  return { service: sandbox.module.exports, calls };
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

await test("mobile admin uses the video config and upload grant actions", async () => {
  const { service, calls } = loadService();

  const config = await service.fetchCaseAdminConfig();
  const prepared = await service.prepareCaseVideoUpload({
    id: "case_doc_1",
    kind: "video",
    fileName: "showcase.mp4",
  });

  assert.equal(config.features.videoUploadEnabled, true);
  assert.equal(prepared.cloudPath, "wine-packaging/videos/grant/video.mp4");
  assert.deepEqual(
    calls.functions.map((call) => JSON.parse(JSON.stringify(call.data))),
    [
      { action: "getAdminConfig" },
      {
        action: "prepareVideoUpload",
        id: "case_doc_1",
        kind: "video",
        fileName: "showcase.mp4",
      },
    ]
  );
});

await test("updateCase sends videoPatch and expectedVersion at the top level", async () => {
  const { service, calls } = loadService();
  const videoPatch = {
    mode: "upload",
    fileID: "cloud://env/wine-packaging/videos/grant/video.mp4",
    durationSeconds: 60,
    posterFileID: "",
  };

  await service.updateCaseAdmin(
    "case_doc_1",
    { title: "案例标题" },
    { videoPatch, expectedVersion: 7 }
  );

  assert.deepEqual(JSON.parse(JSON.stringify(calls.functions[0].data)), {
    action: "updateCase",
    id: "case_doc_1",
    case: { title: "案例标题" },
    videoPatch,
    expectedVersion: 7,
  });
});

await test("legacy edits omit videoPatch instead of clearing an existing video", async () => {
  const { service, calls } = loadService();

  await service.updateCaseAdmin(
    "case_doc_1",
    { title: "只修改标题" },
    { videoPatch: null, expectedVersion: 7 }
  );

  assert.deepEqual(JSON.parse(JSON.stringify(calls.functions[0].data)), {
    action: "updateCase",
    id: "case_doc_1",
    case: { title: "只修改标题" },
    expectedVersion: 7,
  });
});

await test("cloud upload exposes progress and the abortable upload task", async () => {
  const { service, calls } = loadService();
  const progress = [];
  let uploadTask;

  const fileID = await service.uploadCaseVideoMedia({
    filePath: "/tmp/showcase.mp4",
    cloudPath: "wine-packaging/videos/grant/video.mp4",
    onProgress: (value) => progress.push(value),
    onTask: (task) => {
      uploadTask = task;
    },
  });

  assert.equal(fileID, "cloud://env/wine-packaging/videos/grant/video.mp4");
  assert.deepEqual(JSON.parse(JSON.stringify(calls.uploads)), [{
    cloudPath: "wine-packaging/videos/grant/video.mp4",
    filePath: "/tmp/showcase.mp4",
  }]);
  assert.deepEqual(progress, [47]);
  assert.equal(typeof uploadTask.abort, "function");
});

await test("version conflicts preserve the backend currentVersion", async () => {
  const { service } = loadService({ versionConflict: true });

  await assert.rejects(
    service.updateCaseAdmin(
      "case_doc_1",
      { title: "并发修改" },
      { expectedVersion: 7 }
    ),
    (error) => {
      assert.equal(error.code, "VERSION_CONFLICT");
      assert.equal(error.currentVersion, 9);
      return true;
    }
  );
});

await test("cleanup returns deleted skipped and failed file groups", async () => {
  const { service } = loadService();
  const fileIDs = [
    "cloud://env/deleted.mp4",
    "cloud://env/skipped.mp4",
    "cloud://env/failed.mp4",
  ];

  const result = await service.cleanupUnreferencedFiles(fileIDs);

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    deletedFileIds: [fileIDs[0]],
    skippedFileIds: [fileIDs[1]],
    failedFileIds: [fileIDs[2]],
  });
});
