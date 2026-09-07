import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const modulePath = resolve(
  __dirname,
  "../miniprogram/cloudfunctions/caseAdmin/index.js"
);
const logic = require(resolve(
  __dirname,
  "../miniprogram/cloudfunctions/caseAdmin/caseAdminLogic.js"
));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildVariantSet(sourceFileID) {
  const paths = logic.buildExpectedVariantPaths(sourceFileID);
  return {
    sourceGalleryImages: [sourceFileID],
    galleryImages: [`cloud://env/${paths.displayPath}`],
    galleryThumbnails: [`cloud://env/${paths.thumbnailPath}`],
    galleryBanners: [`cloud://env/${paths.bannerPath}`],
    coverImage: `cloud://env/${paths.displayPath}`,
    coverThumbnail: `cloud://env/${paths.thumbnailPath}`,
    coverBanner: `cloud://env/${paths.bannerPath}`,
    imageVariantVersion: 2,
  };
}

function matchesCondition(record, condition = {}) {
  return Object.keys(condition).every((field) => {
    const expected = condition[field];
    if (expected && expected.__op === "in") {
      const actual = record[field];
      return Array.isArray(actual)
        ? actual.some((value) => expected.values.includes(value))
        : expected.values.includes(actual);
    }
    if (expected && expected.__op === "gte") {
      return new Date(record[field]).getTime() >= new Date(expected.value).getTime();
    }
    if (expected && expected.__op === "gt") {
      return record[field] > expected.value;
    }
    return record[field] === expected;
  });
}

function createQuery(
  collectionName,
  records,
  calls,
  condition = {},
  queryGetError = null,
  queryGetHook = null
) {
  const query = {
    limitValue: null,
    skipValue: 0,
    orderField: "",
    orderDirection: "asc",
    where(nextCondition) {
      calls.push({ collectionName, type: "where", condition: nextCondition });
      return createQuery(
        collectionName,
        records,
        calls,
        nextCondition,
        queryGetError,
        queryGetHook
      );
    },
    field(fields) {
      calls.push({ collectionName, type: "field", fields });
      return this;
    },
    limit(value) {
      this.limitValue = value;
      calls.push({ collectionName, type: "limit", value });
      return this;
    },
    orderBy(field, direction) {
      this.orderField = field;
      this.orderDirection = direction;
      calls.push({ collectionName, type: "orderBy", field, direction });
      return this;
    },
    skip(value) {
      this.skipValue = value;
      calls.push({ collectionName, type: "skip", value });
      return this;
    },
    async get() {
      if (
        queryGetError &&
        (!queryGetError.collectionName ||
          queryGetError.collectionName === collectionName)
      ) {
        throw new Error(queryGetError.message || "database unavailable");
      }
      let data = records.filter((record) => matchesCondition(record, condition));
      if (this.orderField) {
        const multiplier = this.orderDirection === "desc" ? -1 : 1;
        data = data.slice().sort((left, right) =>
          String(left[this.orderField] || "").localeCompare(
            String(right[this.orderField] || "")
          ) * multiplier
        );
      }
      data = data.slice(this.skipValue);
      if (this.limitValue !== null) data = data.slice(0, this.limitValue);
      if (queryGetHook) {
        await queryGetHook({ collectionName, condition, records, data, calls });
      }
      return { data: clone(data) };
    },
  };
  return query;
}

function loadCaseAdminFunction(options = {}) {
  const calls = [];
  const warnings = [];
  const deletedFiles = [];
  const tempFileRequests = [];
  const fileInfoRequests = [];
  let transactionCount = 0;
  let deleteFileCallCount = 0;
  const collections = {
    wine_packaging: clone(options.cases || []),
    home_banners: clone(options.banners || []),
    catalog_meta: clone(options.catalogMeta || []),
    case_admin_purge_jobs: clone(options.purgeJobs || []),
    case_admin_upload_jobs: clone(options.uploadJobs || []),
    case_admin_activity_feed: clone(options.activityFeed || []),
    case_admin_video_upload_intents: clone(options.videoUploadIntents || []),
  };

  const mockCloud = {
    DYNAMIC_CURRENT_ENV: "dynamic-env",
    init() {},
    getWXContext() {
      if (options.wxContext) return clone(options.wxContext);
      return {
        OPENID: Object.prototype.hasOwnProperty.call(options, "openid")
          ? options.openid
          : "admin_openid",
      };
    },
    async deleteFile({ fileList }) {
      deleteFileCallCount += 1;
      if (options.deleteFileHook) {
        await options.deleteFileHook({
          fileList: clone(fileList),
          callCount: deleteFileCallCount,
          collections,
          calls,
        });
      }
      if (deleteFileCallCount === options.deleteFileFailureAt) {
        throw new Error(options.deleteFileFailureMessage || "storage unavailable");
      }
      if (options.deleteFileResponseHook) {
        return options.deleteFileResponseHook({
          fileList: clone(fileList),
          callCount: deleteFileCallCount,
          collections,
          calls,
        });
      }
      deletedFiles.push(...fileList);
      return {
        fileList: fileList.map((fileID) => ({ fileID, status: 0 })),
      };
    },
    async getTempFileURL({ fileList }) {
      tempFileRequests.push(...fileList);
      if (options.tempFileURLHook) {
        await options.tempFileURLHook({
          fileList: clone(fileList),
          collections,
          calls,
        });
      }
      return {
        fileList: fileList.map((fileID) => ({
          fileID,
          tempFileURL: `https://temp/${encodeURIComponent(fileID)}`,
        })),
      };
    },
    database() {
      const databaseApi = {
        command: {
          in(values) {
            return { __op: "in", values };
          },
          gte(value) {
            return { __op: "gte", value };
          },
          gt(value) {
            return { __op: "gt", value };
          },
        },
        serverDate() {
          return "server-date";
        },
        collection(collectionName) {
          if (!collections[collectionName]) collections[collectionName] = [];
          const records = collections[collectionName];
          return {
            ...createQuery(
              collectionName,
              records,
              calls,
              {},
              options.queryGetError,
              options.queryGetHook
            ),
            async add(payload) {
              const id = `created_${records.length + 1}`;
              records.push({ _id: id, ...clone(payload.data || {}) });
              calls.push({ collectionName, type: "add", id, payload });
              return { _id: id };
            },
            doc(id) {
              return {
                async get() {
                  calls.push({ collectionName, type: "get", id });
                  const record = records.find((item) => item._id === id);
                  if (!record) throw new Error("document not found");
                  const data = clone(record);
                  if (options.documentGetHook) {
                    await options.documentGetHook({
                      collectionName,
                      id,
                      records,
                      data,
                      calls,
                    });
                  }
                  return { data };
                },
                async remove() {
                  const index = records.findIndex((item) => item._id === id);
                  if (index === -1) throw new Error("document not found");
                  records.splice(index, 1);
                  calls.push({ collectionName, type: "remove", id });
                  return {};
                },
                async update(payload) {
                  const index = records.findIndex((item) => item._id === id);
                  if (index !== -1) {
                    Object.assign(records[index], clone(payload.data || {}));
                  }
                  calls.push({ collectionName, type: "update", id, payload });
                  return {};
                },
                async set(payload) {
                  if (options.documentSetHook) {
                    await options.documentSetHook({
                      collectionName,
                      id,
                      payload,
                      records,
                      calls,
                    });
                  }
                  const index = records.findIndex((item) => item._id === id);
                  const value = { _id: id, ...clone(payload.data || {}) };
                  if (index === -1) records.push(value);
                  else records[index] = value;
                  calls.push({ collectionName, type: "set", id, payload });
                  return {};
                },
              };
            },
          };
        },
      };
      if (options.transactions !== false) {
        databaseApi.runTransaction = async (callback) => {
          transactionCount += 1;
          calls.push({ type: "transaction" });
          if (options.transactionHook) {
            await options.transactionHook({
              transactionCount,
              collections,
              calls,
            });
          }
          if (transactionCount === options.transactionFailureAt) {
            throw new Error(options.transactionFailureMessage || "transaction connection lost");
          }
          try {
            return await callback(databaseApi);
          } finally {
            calls.push({ type: "transactionEnd" });
          }
        };
      }
      return databaseApi;
    },
  };

  const mockHttps = {
    request(url, requestOptions, callback) {
      const handlers = {};
      let completed = false;
      const request = {
        on(eventName, handler) {
          handlers[eventName] = handler;
          return this;
        },
        setTimeout() {
          return this;
        },
        destroy(error) {
          if (completed) return;
          completed = true;
          if (handlers.error) handlers.error(error || new Error("destroyed"));
        },
        end() {
          queueMicrotask(async () => {
            if (completed) return;
            try {
              const parsedUrl = new URL(String(url));
              const fileID = decodeURIComponent(parsedUrl.pathname.slice(1));
              fileInfoRequests.push(fileID);
              const fileInfoResponse = options.fileInfoHook
                ? await options.fileInfoHook({ fileList: [fileID] })
                : {
                  fileList: [{
                    fileID,
                    ...clone((options.fileInfoById || {})[fileID] || {}),
                  }],
                };
              const item = (fileInfoResponse.fileList || [])[0] || {};
              completed = true;
              callback({
                statusCode: Number(item.statusCode) || 200,
                headers: item.headers || {
                  "content-length": String(item.size || ""),
                  "content-type": item.mime || item.contentType || "",
                  ...(item.location ? { location: item.location } : {}),
                },
                resume() {},
              });
            } catch (error) {
              completed = true;
              if (handlers.error) handlers.error(error);
            }
          });
        },
      };
      assert.equal(requestOptions.method, "HEAD");
      return request;
    },
  };

  const sandbox = {
    module: { exports: {} },
    exports: {},
    setTimeout(callback, delay) {
      if (options.immediatePurgeDeleteTimeout) {
        const handle = { fakeTimeout: true, active: true, delay };
        queueMicrotask(() => {
          if (handle.active) callback();
        });
        return handle;
      }
      return setTimeout(callback, delay);
    },
    clearTimeout(handle) {
      if (handle && handle.fakeTimeout) {
        handle.active = false;
        return;
      }
      clearTimeout(handle);
    },
    console: {
      ...console,
      error() {},
      warn(...args) {
        warnings.push(args);
      },
    },
    process: {
      env: {
        ADMIN_OPENIDS: options.adminOpenids || "admin_openid",
        CASE_ADMIN_UIDS: options.adminUids || "",
        ADMIN_WEB_WRITE_ENABLED: options.webWriteEnabled || "",
        ADMIN_ACTIVITY_SYNC_ENABLED: options.activitySyncEnabled || "",
        ADMIN_PERMANENT_DELETE_ENABLED: options.permanentDeleteEnabled || "",
        CASE_ADMIN_DISPLAY_NAMES: options.adminDisplayNames || "",
        VIDEO_UPLOAD_ENABLED: options.videoUploadEnabled || "",
        VIDEO_DISPLAY_ENABLED: options.videoDisplayEnabled || "",
        TCB_ENV: Object.prototype.hasOwnProperty.call(options, "tcbEnv")
          ? options.tcbEnv
          : "env",
      },
    },
    require(moduleName) {
      if (moduleName === "node:crypto") return require("node:crypto");
      if (moduleName === "node:https") return mockHttps;
      if (moduleName === "node:url") return require("node:url");
      if (moduleName === "wx-server-sdk") return mockCloud;
      if (moduleName === "./caseAdminLogic") return logic;
      if (
        moduleName === "@cloudbase/node-sdk"
        && (options.userInfo || options.fileInfoById || options.fileInfoHook)
      ) {
        return {
          SYMBOL_CURRENT_ENV: "current-env",
          init() {
            return {
              auth() {
                return {
                  getUserInfo() {
                    if (options.userInfoError) throw options.userInfoError;
                    return clone(options.userInfo || {});
                  },
                };
              },
              async getFileInfo({ fileList }) {
                fileInfoRequests.push(...fileList);
                if (options.fileInfoHook) {
                  return options.fileInfoHook({ fileList: clone(fileList) });
                }
                return {
                  fileList: fileList.map((fileID) => ({
                    code: "SUCCESS",
                    fileID,
                    ...clone((options.fileInfoById || {})[fileID] || {}),
                  })),
                };
              },
            };
          },
        };
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(readFileSync(modulePath, "utf8"), sandbox, {
    filename: modulePath,
  });

  return {
    main: sandbox.module.exports.main,
    calls,
    warnings,
    collections,
    deletedFiles,
    tempFileRequests,
    fileInfoRequests,
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

function createDeferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

await test("deleteCase rejects non admins", async () => {
  const { main, collections, deletedFiles } = loadCaseAdminFunction({
    openid: "customer_openid",
    cases: [{ _id: "case_doc_1", coverImage: "cloud://env/case.jpg" }],
  });

  const result = await main({ action: "deleteCase", id: "case_doc_1" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "FORBIDDEN");
  assert.equal(collections.wine_packaging.length, 1);
  assert.deepEqual(deletedFiles, []);
});

await test("public visible image URLs exclude original source files", async () => {
  const source = "cloud://env/source.jpg";
  const display = "cloud://env/display.jpg";
  const { main, tempFileRequests } = loadCaseAdminFunction({
    openid: "customer_openid",
    cases: [{
      _id: "case_doc_1",
      isVisible: true,
      galleryImages: [display],
      sourceGalleryImages: [source],
    }],
  });
  const result = await main({
    action: "getVisibleImageUrls",
    fileIDs: [source, display],
  });
  assert.equal(result.ok, true);
  assert.equal(Object.prototype.hasOwnProperty.call(result.urls, source), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result.urls, display), true);
  assert.deepEqual(tempFileRequests, [display]);
});

await test("deleteCase reports missing cases", async () => {
  const { main } = loadCaseAdminFunction();

  const result = await main({ action: "deleteCase", id: "missing_case" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "CASE_NOT_FOUND");
});

await test("cleanupUnreferencedFiles deletes only files confirmed unused", async () => {
  const referenced = `cloud://env/wine-packaging/variants/v2/${"a".repeat(32)}/banner.jpg`;
  const unused = `cloud://env/wine-packaging/variants/v2/${"b".repeat(32)}/display.jpg`;
  const { main, deletedFiles } = loadCaseAdminFunction({
    cases: [{
      _id: "case_doc_1",
      galleryBanners: [referenced],
      coverBanner: referenced,
    }],
  });
  const result = await main({
    action: "cleanupUnreferencedFiles",
    fileIDs: [referenced, unused],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(clone(result.deletedFileIds), [unused]);
  assert.deepEqual(clone(result.skippedFileIds), [referenced]);
  assert.deepEqual(clone(result.failedFileIds), []);
  assert.deepEqual(deletedFiles, [unused]);
});

await test("cleanupUnreferencedFiles reports deleted, skipped and failed files separately", async () => {
  const referenced = `cloud://env/wine-packaging/variants/v2/${"c".repeat(32)}/banner.jpg`;
  const deleted = `cloud://env/wine-packaging/variants/v2/${"d".repeat(32)}/display.jpg`;
  const failed = `cloud://env/wine-packaging/variants/v2/${"e".repeat(32)}/thumbnail.jpg`;
  const loaded = loadCaseAdminFunction({
    deleteFileFailureAt: 2,
    cases: [{
      _id: "partial-cleanup-case",
      galleryBanners: [referenced],
      coverBanner: referenced,
    }],
  });
  const result = await loaded.main({
    action: "cleanupUnreferencedFiles",
    fileIDs: [deleted, referenced, failed],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(clone(result.deletedFileIds), [deleted]);
  assert.deepEqual(clone(result.skippedFileIds), [referenced]);
  assert.deepEqual(clone(result.failedFileIds), [failed]);
  assert.deepEqual(
    [
      ...result.deletedFileIds,
      ...result.skippedFileIds,
      ...result.failedFileIds,
    ].sort(),
    [deleted, referenced, failed].sort()
  );
  assert.deepEqual(loaded.deletedFiles, [deleted]);
  const warning = loaded.warnings.find(
    ([message]) => message === "case file cleanup failed"
  );
  assert.equal(JSON.stringify(warning).includes(failed), false);
});

await test("cleanupUnreferencedFiles rejects paths outside the case namespace", async () => {
  const { main, deletedFiles } = loadCaseAdminFunction();
  const result = await main({
    action: "cleanupUnreferencedFiles",
    fileIDs: ["cloud://env/another-product/private-file.jpg"],
  });
  assert.equal(result.code, "INVALID_CLEANUP_PATH");
  assert.deepEqual(deletedFiles, []);
});

await test("deleteCase moves a case to trash without deleting any files", async () => {
  const videoFileID = "cloud://env/wine-packaging/videos/aaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbb/cccccccccccccccccccccccccccccccc.mp4";
  const { main, collections, deletedFiles } = loadCaseAdminFunction({
    cases: [{
      _id: "case_doc_1",
      coverImage: "cloud://env/case.jpg",
      isVisible: true,
      isPinned: true,
      homeSections: { values: ["banner"] },
      videoFileID,
      videoDurationSeconds: 60,
      version: 3,
    }],
  });

  const result = await main({ action: "deleteCase", id: "case_doc_1" });

  assert.equal(result.ok, true);
  assert.equal(result.id, "case_doc_1");
  assert.deepEqual(deletedFiles, []);
  assert.equal(collections.wine_packaging.length, 1);
  assert.equal(collections.wine_packaging[0].deletedAt, "server-date");
  assert.equal(collections.wine_packaging[0].isVisible, false);
  assert.equal(collections.wine_packaging[0].isPinned, false);
  assert.deepEqual(collections.wine_packaging[0].homeSections, { values: [] });
  assert.equal(collections.wine_packaging[0].version, 4);
  assert.equal(collections.wine_packaging[0].videoFileID, videoFileID);
  const legacyList = await main({ action: "listCases", page: 1, pageSize: 20 });
  assert.deepEqual(clone(legacyList.items), []);
});

await test("createCase rejects the twenty-first configured pinned case", async () => {
  const cases = Array.from({ length: 20 }, (_, index) => ({
    _id: `pinned_${index}`,
    isPinned: true,
  }));
  const { main } = loadCaseAdminFunction({ cases });

  const result = await main({
    action: "createCase",
    case: {
      title: "超出置顶上限",
      galleryImages: ["cloud://env/new.jpg"],
      packageTypes: ["礼盒"],
      isPinned: true,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "PINNED_LIMIT_REACHED");
});

await test("createCase reports when the homepage popular slot is full", async () => {
  const cases = Array.from({ length: logic.HOME_DISPLAY_LIMITS.popular }, (_, index) => ({
    _id: `popular_${index}`,
    caseId: `case_00${index + 1}`,
    coverImage: `cloud://env/popular-${index}.jpg`,
    isVisible: true,
    sortOrder: index + 1,
    homeSections: { values: ["popular"] },
  }));
  const { main, collections } = loadCaseAdminFunction({ cases });

  const result = await main({
    action: "createCase",
    case: {
      title: "小猫案例",
      galleryImages: ["cloud://env/cat.jpg"],
      packageTypes: ["礼盒"],
      homeSections: ["popular"],
      isVisible: true,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "HOME_DISPLAY_LIMIT_REACHED");
  assert.equal(result.message.includes("热门产品最多展示 4 个"), true);
  assert.equal(collections.wine_packaging.length, logic.HOME_DISPLAY_LIMITS.popular);
});

await test("hidden cases can reserve homepage selections without using display capacity", async () => {
  const cases = Array.from({ length: logic.HOME_DISPLAY_LIMITS.popular }, (_, index) => ({
    _id: `popular_${index}`,
    caseId: `case_00${index + 1}`,
    isVisible: true,
    homeSections: { values: ["popular"] },
  }));
  const { main, collections } = loadCaseAdminFunction({ cases });

  const result = await main({
    action: "createCase",
    case: {
      title: "隐藏小猫案例",
      galleryImages: ["cloud://env/cat.jpg"],
      packageTypes: ["礼盒"],
      homeSections: ["popular"],
      isVisible: false,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(collections.wine_packaging.length, logic.HOME_DISPLAY_LIMITS.popular + 1);
});

await test("restoring a hidden case reports when its homepage slot is full", async () => {
  const cases = [
    ...Array.from({ length: logic.HOME_DISPLAY_LIMITS.popular }, (_, index) => ({
      _id: `popular_${index}`,
      caseId: `case_00${index + 1}`,
      isVisible: true,
      homeSections: { values: ["popular"] },
    })),
    {
      _id: "hidden_cat",
      caseId: "case_099",
      title: "隐藏小猫",
      coverImage: "cloud://env/hidden-cat.jpg",
      galleryImages: ["cloud://env/hidden-cat.jpg"],
      packageTypes: { values: ["礼盒"] },
      isVisible: false,
      homeSections: { values: ["popular"] },
    },
  ];
  const { main, calls } = loadCaseAdminFunction({ cases });

  const result = await main({
    action: "setCaseVisibility",
    id: "hidden_cat",
    isVisible: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "HOME_DISPLAY_LIMIT_REACHED");
  assert.equal(
    calls.some((call) => call.type === "update" && call.id === "hidden_cat"),
    false
  );
});

await test("homepage display endpoint is admin-only and returns the active homepage slot", async () => {
  const { main } = loadCaseAdminFunction({
    cases: [
      { _id: "case_1", caseId: "case_001", title: "热门案例", coverImage: "cloud://env/case.jpg", isVisible: true, sortOrder: 1, homeSections: { values: ["popular"] } },
      { _id: "case_2", caseId: "case_002", title: "隐藏案例", coverImage: "cloud://env/hidden.jpg", isVisible: false, sortOrder: 0, homeSections: { values: ["popular"] } },
    ],
  });

  const result = await main({ action: "listHomepageDisplay", slot: "popular" });

  assert.equal(result.ok, true);
  assert.equal(result.slot, "popular");
  assert.deepEqual(clone(result.items.map((item) => item.caseId)), ["case_001"]);
  assert.equal(result.items[0].displayOrderLabel, "第 1 个");

  const customer = loadCaseAdminFunction({ openid: "customer_openid" });
  const forbidden = await customer.main({ action: "listHomepageDisplay", slot: "popular" });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.code, "FORBIDDEN");
});

await test("recent case endpoint only returns visible cases created in the last 24 hours", async () => {
  const now = Date.now();
  const { main } = loadCaseAdminFunction({
    cases: [
      { _id: "recent_visible", title: "近期案例", isVisible: true, createdAt: new Date(now - 60 * 60 * 1000).toISOString() },
      { _id: "recent_hidden", title: "隐藏案例", isVisible: false, createdAt: new Date(now - 60 * 60 * 1000).toISOString() },
      { _id: "old_visible", title: "旧案例", isVisible: true, createdAt: new Date(now - 25 * 60 * 60 * 1000).toISOString() },
    ],
  });
  const result = await main({ action: "listRecentCases", page: 1, pageSize: 20 });
  assert.equal(result.ok, true);
  assert.deepEqual(clone(result.items.map((item) => item._id)), ["recent_visible"]);

  const customer = loadCaseAdminFunction({ openid: "customer_openid" });
  const forbidden = await customer.main({ action: "listRecentCases" });
  assert.equal(forbidden.code, "FORBIDDEN");
});

await test("CloudBase UID access uses the official server SDK and honors the web write switch", async () => {
  const options = {
    wxContext: {},
    userInfo: { uid: "web-admin-1", openId: "", isAnonymous: false },
    adminUids: "web-admin-1",
  };
  const readonly = loadCaseAdminFunction(options);
  const access = await readonly.main({ action: "checkAccess" });
  const list = await readonly.main({ action: "listCasesV2", page: 1, pageSize: 20 });
  const config = await readonly.main({ action: "getAdminConfig" });
  const write = await readonly.main({
    action: "moveCasesToTrash",
    ids: ["case_1"],
    expectedVersions: { case_1: 1 },
  });
  assert.equal(access.ok, true);
  assert.equal(access.actor.type, "cloudbase_uid");
  assert.equal(list.ok, true);
  assert.equal(config.config.options.wineTypes.includes("白酒"), true);
  assert.equal(config.config.limits.gallery, 9);
  assert.equal(config.config.limits.homepage.latest, 6);
  assert.equal(config.config.writeEnabled, false);
  assert.deepEqual(clone(config.config.homeSectionOrders), {
    banner: [],
    popular: [],
    latest: [],
  });
  assert.equal(write.code, "WEB_WRITE_DISABLED");

  const forbidden = loadCaseAdminFunction({
    ...options,
    adminUids: "another-admin",
  });
  assert.equal((await forbidden.main({ action: "listCasesV2" })).code, "FORBIDDEN");
});

await test("admin config exposes fail-closed video feature gates and upload limits", async () => {
  const disabled = loadCaseAdminFunction();
  const disabledResult = await disabled.main({ action: "getAdminConfig" });
  assert.equal(disabledResult.ok, true);
  assert.deepEqual(clone(disabledResult.config.features), {
    videoUploadEnabled: false,
    videoDisplayEnabled: false,
  });
  assert.equal(disabledResult.config.limits.videoUploadBytes, 104857600);
  assert.equal(disabledResult.config.limits.videoDurationSeconds, 120);
  assert.equal(disabledResult.config.limits.videoPosterUploadBytes, 5242880);
  assert.deepEqual(clone(disabledResult.config.upload.video.acceptedExtensions), [".mp4"]);

  const enabled = loadCaseAdminFunction({
    videoUploadEnabled: "true",
    videoDisplayEnabled: "true",
  });
  const enabledResult = await enabled.main({ action: "getAdminConfig" });
  assert.deepEqual(clone(enabledResult.config.features), {
    videoUploadEnabled: true,
    videoDisplayEnabled: true,
  });

  const blocked = await disabled.main({
    action: "prepareVideoUpload",
    id: "missing",
    kind: "video",
    fileName: "demo.mp4",
  });
  assert.equal(blocked.code, "VIDEO_UPLOAD_DISABLED");
});

await test("prepared video and poster uploads bind atomically and return admin previews", async () => {
  const loaded = loadCaseAdminFunction({
    videoUploadEnabled: "true",
    cases: [{
      _id: "video-case",
      title: "视频案例",
      caseId: "case_501",
      coverImage: "cloud://env/cover.jpg",
      galleryImages: ["cloud://env/cover.jpg"],
      packageTypes: { values: ["礼盒"] },
      isVisible: false,
      version: 1,
    }],
    fileInfoHook({ fileList }) {
      return {
        fileList: fileList.map((fileID) => ({
          code: "SUCCESS",
          fileID,
          size: fileID.includes("/posters/") ? 5242880 : 104857600,
          mime: fileID.includes("/posters/") ? "image/jpeg" : "video/mp4",
        })),
      };
    },
  });
  const videoPrepared = await loaded.main({
    action: "prepareVideoUpload",
    id: "video-case",
    kind: "video",
    fileName: "demo.mp4",
  });
  const posterPrepared = await loaded.main({
    action: "prepareVideoUpload",
    id: "video-case",
    kind: "poster",
    fileName: "poster.jpg",
  });
  assert.equal(videoPrepared.ok, true);
  assert.equal(posterPrepared.ok, true);
  assert.match(videoPrepared.cloudPath, /^wine-packaging\/videos\/[a-f0-9]{24}\/[a-f0-9]{24}\/[a-f0-9]{32}\.mp4$/);
  assert.match(posterPrepared.cloudPath, /^wine-packaging\/videos\/[a-f0-9]{24}\/[a-f0-9]{24}\/posters\/[a-f0-9]{32}\.jpg$/);
  const videoFileID = `cloud://env/${videoPrepared.cloudPath}`;
  const posterFileID = `cloud://env/${posterPrepared.cloudPath}`;
  const saved = await loaded.main({
    action: "updateCase",
    id: "video-case",
    case: { notes: "已配置视频" },
    expectedVersion: 1,
    videoPatch: {
      mode: "upload",
      fileID: videoFileID,
      posterFileID,
      durationSeconds: 119.2,
    },
  });
  assert.equal(saved.ok, true);
  const transactionStart = loaded.calls.findIndex((call) => call.type === "transaction");
  const transactionEnd = loaded.calls.findIndex(
    (call, index) => index > transactionStart && call.type === "transactionEnd"
  );
  const transactionCalls = loaded.calls.slice(transactionStart + 1, transactionEnd);
  const firstWriteIndex = transactionCalls.findIndex(
    (call) => ["add", "remove", "set", "update"].includes(call.type)
  );
  const lastReadIndex = transactionCalls.reduce(
    (index, call, callIndex) => call.type === "get" ? callIndex : index,
    -1
  );
  assert.equal(firstWriteIndex > lastReadIndex, true);
  assert.equal(
    transactionCalls.filter(
      (call) => call.type === "get"
        && call.collectionName === "case_admin_video_upload_intents"
    ).length,
    2
  );
  const stored = loaded.collections.wine_packaging[0];
  assert.equal(stored.videoFileID, videoFileID);
  assert.equal(stored.videoUrl, "");
  assert.equal(stored.videoPosterFileID, posterFileID);
  assert.equal(stored.videoDurationSeconds, 120);
  assert.equal(stored.videoFileSizeBytes, 104857600);
  assert.equal(
    loaded.collections.case_admin_video_upload_intents.every(
      (intent) => intent.status === "consumed" && intent.consumedByCaseId === "video-case"
    ),
    true
  );
  const detail = await loaded.main({ action: "getCase", id: "video-case" });
  assert.equal(detail.item.videoPreviewUrl, `https://temp/${encodeURIComponent(videoFileID)}`);
  assert.equal(
    detail.item.videoPosterPreviewUrl,
    `https://temp/${encodeURIComponent(posterFileID)}`
  );
  const cleared = await loaded.main({
    action: "updateCase",
    id: "video-case",
    case: {},
    expectedVersion: 2,
    videoPatch: { mode: "clear" },
  });
  assert.equal(cleared.ok, true);
  assert.equal(loaded.collections.wine_packaging[0].videoFileID, "");
  assert.equal(loaded.collections.wine_packaging[0].videoPosterFileID, "");
  assert.equal(loaded.collections.wine_packaging[0].videoDurationSeconds, null);
  assert.deepEqual(new Set(loaded.deletedFiles), new Set([videoFileID, posterFileID]));
});

await test("video upload validation fails closed for cross-environment, MIME and size errors", async () => {
  for (const scenario of [
    { authority: "other-env", code: "CROSS_ENV_VIDEO_FILE" },
    { authority: "env", tcbEnv: "", code: "STORAGE_ENV_UNAVAILABLE" },
    { authority: "env", mime: "video/quicktime", code: "INVALID_VIDEO_MIME" },
    { authority: "env", mime: "video/mp4", size: 104857601, code: "VIDEO_FILE_TOO_LARGE" },
  ]) {
    const loaded = loadCaseAdminFunction({
      videoUploadEnabled: "true",
      ...(Object.prototype.hasOwnProperty.call(scenario, "tcbEnv")
        ? { tcbEnv: scenario.tcbEnv }
        : {}),
      cases: [{
        _id: "video-validation-case",
        title: "验证案例",
        coverImage: "cloud://env/cover.jpg",
        galleryImages: ["cloud://env/cover.jpg"],
        packageTypes: { values: ["礼盒"] },
        isVisible: false,
        version: 1,
      }],
      fileInfoHook({ fileList }) {
        return {
          fileList: fileList.map((fileID) => ({
            code: "SUCCESS",
            fileID,
            mime: scenario.mime || "video/mp4",
            size: scenario.size || 1024,
          })),
        };
      },
    });
    const prepared = await loaded.main({
      action: "prepareVideoUpload",
      id: "video-validation-case",
      kind: "video",
      fileName: "demo.mp4",
    });
    const fileID = `cloud://${scenario.authority}/${prepared.cloudPath}`;
    const result = await loaded.main({
      action: "updateCase",
      id: "video-validation-case",
      case: {},
      expectedVersion: 1,
      videoPatch: { mode: "upload", fileID, durationSeconds: 60 },
    });
    assert.equal(result.code, scenario.code);
    assert.equal(loaded.collections.wine_packaging[0].videoFileID, undefined);
  }
});

await test("external video patches work while upload is disabled and direct legacy fields are ignored", async () => {
  const loaded = loadCaseAdminFunction({
    cases: [{
      _id: "external-case",
      title: "外链案例",
      coverImage: "cloud://env/cover.jpg",
      galleryImages: ["cloud://env/cover.jpg"],
      packageTypes: { values: ["礼盒"] },
      isVisible: false,
      version: 1,
      videoUrl: "https://old.example.com/video.mp4",
    }],
  });
  const ignored = await loaded.main({
    action: "updateCase",
    id: "external-case",
    case: { videoUrl: "https://ignored.example.com/video.mp4" },
  });
  assert.equal(ignored.ok, true);
  assert.equal(
    loaded.collections.wine_packaging[0].videoUrl,
    "https://old.example.com/video.mp4"
  );
  const external = await loaded.main({
    action: "updateCase",
    id: "external-case",
    case: {},
    expectedVersion: 2,
    videoPatch: {
      mode: "external",
      url: "https://media.example.com/video.mp4",
      posterUrl: "https://media.example.com/poster.webp",
      durationSeconds: 75,
    },
  });
  assert.equal(external.ok, true);
  assert.equal(
    loaded.collections.wine_packaging[0].videoUrl,
    "https://media.example.com/video.mp4"
  );
  assert.equal(loaded.collections.wine_packaging[0].videoFileID, "");
  assert.equal(loaded.collections.wine_packaging[0].videoDurationSeconds, 75);
});

await test("a disabled upload gate still allows an existing upload to remove its poster", async () => {
  const videoFileID = "cloud://env/wine-packaging/videos/aaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbb/cccccccccccccccccccccccccccccccc.mp4";
  const posterFileID = "cloud://env/wine-packaging/videos/aaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbb/posters/dddddddddddddddddddddddddddddddd.webp";
  const loaded = loadCaseAdminFunction({
    cases: [{
      _id: "existing-video-case",
      title: "已有视频案例",
      coverImage: "cloud://env/cover.jpg",
      galleryImages: ["cloud://env/cover.jpg"],
      packageTypes: { values: ["礼盒"] },
      isVisible: false,
      version: 1,
      videoFileID,
      videoPosterFileID: posterFileID,
      videoDurationSeconds: 60,
      videoFileSizeBytes: 1024,
    }],
  });

  const result = await loaded.main({
    action: "updateCase",
    id: "existing-video-case",
    case: {},
    expectedVersion: 1,
    videoPatch: {
      mode: "upload",
      fileID: videoFileID,
      durationSeconds: 60,
      posterFileID: "",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(loaded.collections.wine_packaging[0].videoFileID, videoFileID);
  assert.equal(loaded.collections.wine_packaging[0].videoPosterFileID, "");
  assert.deepEqual(loaded.fileInfoRequests, []);
  assert.deepEqual(loaded.deletedFiles, [posterFileID]);
});

await test("every explicit video patch requires an expected case version", async () => {
  const loaded = loadCaseAdminFunction({
    videoUploadEnabled: "true",
    cases: [{
      _id: "version-required-video-case",
      title: "视频版本案例",
      coverImage: "cloud://env/cover.jpg",
      galleryImages: ["cloud://env/cover.jpg"],
      packageTypes: { values: ["礼盒"] },
      isVisible: false,
      version: 1,
    }],
  });
  const patches = [
    {
      mode: "upload",
      fileID: "cloud://env/wine-packaging/videos/aaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbb/cccccccccccccccccccccccccccccccc.mp4",
      durationSeconds: 60,
    },
    { mode: "external", url: "https://media.example.com/video.mp4" },
    { mode: "clear" },
  ];
  for (const videoPatch of patches) {
    const result = await loaded.main({
      action: "updateCase",
      id: "version-required-video-case",
      case: {},
      videoPatch,
    });
    assert.equal(result.code, "EXPECTED_VERSION_REQUIRED");
  }
  assert.equal(loaded.collections.wine_packaging[0].version, 1);
  assert.deepEqual(loaded.fileInfoRequests, []);
});

await test("another administrator can retain bound video fields while replacing only one file", async () => {
  const caseDocumentId = "cross-admin-video-case";
  const originalActor = { type: "wechat_openid", id: "admin-a" };
  const originalVideo = logic.buildPreparedVideoUpload({
    actor: originalActor,
    caseDocumentId,
    kind: "video",
    fileName: "old.mp4",
    uploadId: "a".repeat(32),
  });
  const originalPoster = logic.buildPreparedVideoUpload({
    actor: originalActor,
    caseDocumentId,
    kind: "poster",
    fileName: "old.jpg",
    uploadId: "b".repeat(32),
  });
  assert.equal(originalVideo.valid, true);
  assert.equal(originalPoster.valid, true);
  const originalVideoFileID = `cloud://env/${originalVideo.cloudPath}`;
  const originalPosterFileID = `cloud://env/${originalPoster.cloudPath}`;

  for (const replacedKind of ["poster", "video"]) {
    const loaded = loadCaseAdminFunction({
      openid: "admin-b",
      adminOpenids: "admin-b",
      videoUploadEnabled: "true",
      cases: [{
        _id: caseDocumentId,
        title: "跨管理员视频案例",
        coverImage: "cloud://env/cover.jpg",
        galleryImages: ["cloud://env/cover.jpg"],
        packageTypes: { values: ["礼盒"] },
        isVisible: false,
        version: 1,
        videoFileID: originalVideoFileID,
        videoPosterFileID: originalPosterFileID,
        videoDurationSeconds: 60,
        videoFileSizeBytes: 4096,
      }],
      fileInfoHook({ fileList }) {
        return {
          fileList: fileList.map((fileID) => ({
            code: "SUCCESS",
            fileID,
            size: replacedKind === "video" ? 8192 : 2048,
            mime: replacedKind === "video" ? "video/mp4" : "image/jpeg",
          })),
        };
      },
    });
    const prepared = await loaded.main({
      action: "prepareVideoUpload",
      id: caseDocumentId,
      kind: replacedKind,
      fileName: replacedKind === "video" ? "new.mp4" : "new.jpg",
    });
    assert.equal(prepared.ok, true);
    const introducedFileID = `cloud://env/${prepared.cloudPath}`;
    const saved = await loaded.main({
      action: "updateCase",
      id: caseDocumentId,
      case: {},
      expectedVersion: 1,
      videoPatch: {
        mode: "upload",
        fileID: replacedKind === "video" ? introducedFileID : originalVideoFileID,
        posterFileID: replacedKind === "poster" ? introducedFileID : originalPosterFileID,
        durationSeconds: 61,
      },
    });
    assert.equal(saved.ok, true);
    assert.deepEqual(loaded.fileInfoRequests, [introducedFileID]);
    const stored = loaded.collections.wine_packaging[0];
    assert.equal(
      stored.videoFileID,
      replacedKind === "video" ? introducedFileID : originalVideoFileID
    );
    assert.equal(
      stored.videoPosterFileID,
      replacedKind === "poster" ? introducedFileID : originalPosterFileID
    );
    assert.equal(stored.videoFileSizeBytes, replacedKind === "video" ? 8192 : 4096);
    assert.equal(loaded.collections.case_admin_video_upload_intents.length, 1);
    assert.equal(loaded.collections.case_admin_video_upload_intents[0].status, "consumed");
  }
});

await test("version conflicts preserve prepared uploads for retry", async () => {
  const uid = "web-admin-1";
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    webWriteEnabled: "true",
    videoUploadEnabled: "true",
    cases: [{
      _id: "conflict-video-case",
      title: "冲突案例",
      coverImage: "cloud://env/cover.jpg",
      galleryImages: ["cloud://env/cover.jpg"],
      packageTypes: { values: ["礼盒"] },
      isVisible: false,
      version: 1,
    }],
  });
  const prepared = await loaded.main({
    action: "prepareVideoUpload",
    id: "conflict-video-case",
    kind: "video",
    fileName: "demo.mp4",
  });
  const fileID = `cloud://env/${prepared.cloudPath}`;
  const result = await loaded.main({
    action: "updateCase",
    id: "conflict-video-case",
    case: {},
    expectedVersion: 2,
    videoPatch: { mode: "upload", fileID, durationSeconds: 60 },
  });
  assert.equal(result.code, "VERSION_CONFLICT");
  assert.equal(loaded.collections.wine_packaging[0].videoFileID, undefined);
  assert.equal(loaded.collections.case_admin_video_upload_intents[0].status, "prepared");
  assert.deepEqual(loaded.deletedFiles, []);
  assert.deepEqual(loaded.fileInfoRequests, []);
});

await test("unreferenced prepared video cleanup is actor-scoped", async () => {
  const loaded = loadCaseAdminFunction({
    videoUploadEnabled: "true",
    cases: [{
      _id: "cleanup-video-case",
      title: "清理案例",
      coverImage: "cloud://env/cover.jpg",
      galleryImages: ["cloud://env/cover.jpg"],
      packageTypes: { values: ["礼盒"] },
      isVisible: false,
      version: 1,
    }],
  });
  const prepared = await loaded.main({
    action: "prepareVideoUpload",
    id: "cleanup-video-case",
    kind: "video",
    fileName: "unused.mp4",
  });
  const fileID = `cloud://env/${prepared.cloudPath}`;
  const result = await loaded.main({
    action: "cleanupUnreferencedFiles",
    fileIDs: [fileID],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(clone(result.deletedFileIds), [fileID]);
  assert.deepEqual(loaded.deletedFiles, [fileID]);

  const other = loadCaseAdminFunction({
    openid: "other-admin",
    adminOpenids: "other-admin",
  });
  const forbidden = await other.main({
    action: "cleanupUnreferencedFiles",
    fileIDs: [fileID],
  });
  assert.equal(forbidden.code, "INVALID_CLEANUP_PATH");
  assert.deepEqual(other.deletedFiles, []);
});

await test("a cleanup claim after save preflight blocks the save transaction", async () => {
  const updateTransactionReady = createDeferred();
  const releaseUpdateTransaction = createDeferred();
  const deleteStarted = createDeferred();
  const releaseDelete = createDeferred();
  let videoFileID = "";
  const loaded = loadCaseAdminFunction({
    videoUploadEnabled: "true",
    cases: [{
      _id: "cleanup-wins-video-case",
      title: "清理优先案例",
      coverImage: "cloud://env/cover.jpg",
      galleryImages: ["cloud://env/cover.jpg"],
      packageTypes: { values: ["礼盒"] },
      isVisible: false,
      version: 1,
    }],
    fileInfoHook({ fileList }) {
      return {
        fileList: fileList.map((fileID) => ({
          code: "SUCCESS",
          fileID,
          size: 4096,
          mime: "video/mp4",
        })),
      };
    },
    async transactionHook({ transactionCount }) {
      if (transactionCount !== 1) return;
      updateTransactionReady.resolve();
      await releaseUpdateTransaction.promise;
    },
    async deleteFileHook({ fileList }) {
      if (!videoFileID || !fileList.includes(videoFileID)) return;
      deleteStarted.resolve();
      await releaseDelete.promise;
    },
  });
  const prepared = await loaded.main({
    action: "prepareVideoUpload",
    id: "cleanup-wins-video-case",
    kind: "video",
    fileName: "race.mp4",
  });
  videoFileID = `cloud://env/${prepared.cloudPath}`;
  const savePromise = loaded.main({
    action: "updateCase",
    id: "cleanup-wins-video-case",
    case: {},
    expectedVersion: 1,
    videoPatch: { mode: "upload", fileID: videoFileID, durationSeconds: 60 },
  });
  await updateTransactionReady.promise;
  assert.deepEqual(loaded.fileInfoRequests, [videoFileID]);

  const cleanupPromise = loaded.main({
    action: "cleanupUnreferencedFiles",
    fileIDs: [videoFileID],
  });
  await deleteStarted.promise;
  assert.equal(
    loaded.collections.case_admin_video_upload_intents[0].status,
    "cleanup_claimed"
  );
  const transactionStarts = loaded.calls.reduce((indexes, call, index) => {
    if (call.type === "transaction") indexes.push(index);
    return indexes;
  }, []);
  const cleanupTransactionStart = transactionStarts[1];
  const cleanupTransactionEnd = loaded.calls.findIndex(
    (call, index) => index > cleanupTransactionStart && call.type === "transactionEnd"
  );
  const cleanupTransactionCalls = loaded.calls.slice(
    cleanupTransactionStart + 1,
    cleanupTransactionEnd
  );
  const intentReadIndex = cleanupTransactionCalls.findIndex(
    (call) => call.type === "get"
      && call.collectionName === "case_admin_video_upload_intents"
  );
  const intentWriteIndex = cleanupTransactionCalls.findIndex(
    (call) => call.type === "update"
      && call.collectionName === "case_admin_video_upload_intents"
  );
  assert.equal(intentReadIndex >= 0 && intentWriteIndex > intentReadIndex, true);

  releaseUpdateTransaction.resolve();
  const saveResult = await savePromise;
  assert.equal(saveResult.code, "VIDEO_UPLOAD_CLEANUP_CLAIMED");
  assert.equal(loaded.collections.wine_packaging[0].videoFileID, undefined);
  assert.equal(loaded.collections.wine_packaging[0].version, 1);

  releaseDelete.resolve();
  const cleanupResult = await cleanupPromise;
  assert.deepEqual(clone(cleanupResult.deletedFileIds), [videoFileID]);
  assert.deepEqual(loaded.deletedFiles, [videoFileID]);
  assert.equal(loaded.collections.wine_packaging[0].videoFileID, undefined);
});

await test("a committed video save makes concurrent client cleanup skip deletion", async () => {
  const previewStarted = createDeferred();
  const releasePreview = createDeferred();
  let videoFileID = "";
  const loaded = loadCaseAdminFunction({
    videoUploadEnabled: "true",
    cases: [{
      _id: "save-wins-video-case",
      title: "保存优先案例",
      coverImage: "cloud://env/cover.jpg",
      galleryImages: ["cloud://env/cover.jpg"],
      packageTypes: { values: ["礼盒"] },
      isVisible: false,
      version: 1,
    }],
    fileInfoHook({ fileList }) {
      return {
        fileList: fileList.map((fileID) => ({
          code: "SUCCESS",
          fileID,
          size: 4096,
          mime: "video/mp4",
        })),
      };
    },
    async tempFileURLHook({ fileList, collections }) {
      const intent = collections.case_admin_video_upload_intents[0];
      if (
        videoFileID
        && fileList.includes(videoFileID)
        && intent
        && intent.status === "consumed"
      ) {
        previewStarted.resolve();
        await releasePreview.promise;
      }
    },
  });
  const prepared = await loaded.main({
    action: "prepareVideoUpload",
    id: "save-wins-video-case",
    kind: "video",
    fileName: "race.mp4",
  });
  videoFileID = `cloud://env/${prepared.cloudPath}`;
  const savePromise = loaded.main({
    action: "updateCase",
    id: "save-wins-video-case",
    case: {},
    expectedVersion: 1,
    videoPatch: { mode: "upload", fileID: videoFileID, durationSeconds: 60 },
  });
  await previewStarted.promise;
  assert.equal(loaded.collections.wine_packaging[0].videoFileID, videoFileID);
  assert.equal(loaded.collections.case_admin_video_upload_intents[0].status, "consumed");

  const cleanupResult = await loaded.main({
    action: "cleanupUnreferencedFiles",
    fileIDs: [videoFileID],
  });
  assert.deepEqual(clone(cleanupResult.deletedFileIds), []);
  assert.deepEqual(clone(cleanupResult.skippedFileIds), [videoFileID]);
  assert.deepEqual(loaded.deletedFiles, []);
  assert.equal(loaded.collections.wine_packaging[0].videoFileID, videoFileID);

  releasePreview.resolve();
  const saveResult = await savePromise;
  assert.equal(saveResult.ok, true);
  assert.equal(loaded.collections.wine_packaging[0].videoFileID, videoFileID);
  assert.deepEqual(loaded.deletedFiles, []);
});

await test("a claimed video cleanup can retry after storage deletion fails", async () => {
  const loaded = loadCaseAdminFunction({
    videoUploadEnabled: "true",
    deleteFileFailureAt: 1,
    cases: [{
      _id: "retry-cleanup-video-case",
      title: "清理重试案例",
      coverImage: "cloud://env/cover.jpg",
      galleryImages: ["cloud://env/cover.jpg"],
      packageTypes: { values: ["礼盒"] },
      isVisible: false,
      version: 1,
    }],
  });
  const prepared = await loaded.main({
    action: "prepareVideoUpload",
    id: "retry-cleanup-video-case",
    kind: "video",
    fileName: "retry.mp4",
  });
  const videoFileID = `cloud://env/${prepared.cloudPath}`;
  const first = await loaded.main({
    action: "cleanupUnreferencedFiles",
    fileIDs: [videoFileID],
  });
  assert.deepEqual(clone(first.deletedFileIds), []);
  assert.deepEqual(clone(first.skippedFileIds), []);
  assert.deepEqual(clone(first.failedFileIds), [videoFileID]);
  assert.equal(
    loaded.collections.case_admin_video_upload_intents[0].status,
    "cleanup_claimed"
  );
  const cleanupWarning = loaded.warnings.find(
    ([message]) => message === "case file cleanup failed"
  );
  assert.deepEqual(clone(cleanupWarning), [
    "case file cleanup failed",
    {
      stage: "delete_unreferenced_file",
      errorCode: "STORAGE_DELETE_FAILED",
    },
  ]);
  assert.equal(JSON.stringify(cleanupWarning).includes(videoFileID), false);

  const retry = await loaded.main({
    action: "cleanupUnreferencedFiles",
    fileIDs: [videoFileID],
  });
  assert.deepEqual(clone(retry.deletedFileIds), [videoFileID]);
  assert.deepEqual(clone(retry.skippedFileIds), []);
  assert.deepEqual(clone(retry.failedFileIds), []);
  assert.deepEqual(loaded.deletedFiles, [videoFileID]);
});

await test("permanent deletion includes managed video and poster files", async () => {
  const uid = "web-admin-1";
  const actor = { type: "cloudbase_uid", id: uid };
  const videoPath = logic.buildPreparedVideoUpload({
    actor,
    caseDocumentId: "trash-video",
    kind: "video",
    fileName: "video.mp4",
    uploadId: "a".repeat(32),
  }).cloudPath;
  const posterPath = logic.buildPreparedVideoUpload({
    actor,
    caseDocumentId: "trash-video",
    kind: "poster",
    fileName: "poster.webp",
    uploadId: "b".repeat(32),
  }).cloudPath;
  const videoFileID = `cloud://env/${videoPath}`;
  const posterFileID = `cloud://env/${posterPath}`;
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    webWriteEnabled: "true",
    permanentDeleteEnabled: "true",
    cases: [{
      _id: "trash-video",
      title: "待永久删除",
      caseId: "case_888",
      coverImage: "",
      galleryImages: [],
      videoFileID,
      videoPosterFileID: posterFileID,
      deletedAt: "2026-08-01",
      version: 3,
    }],
  });
  const result = await loaded.main({
    action: "permanentlyDeleteCases",
    ids: ["trash-video"],
    expectedVersions: { "trash-video": 3 },
    clientMutationId: "purge-video-case",
  });
  assert.equal(result.ok, true);
  assert.equal(result.deletedFileCount, 2);
  assert.deepEqual(new Set(loaded.deletedFiles), new Set([videoFileID, posterFileID]));
});

await test("identity service failures are not reported as permission denials", async () => {
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: {},
    userInfoError: new Error("identity backend unavailable"),
    adminUids: "web-admin-1",
  });
  const result = await loaded.main({ action: "listCasesV2" });
  assert.equal(result.code, "SERVER_ERROR");
  assert.notEqual(result.code, "FORBIDDEN");
});

await test("database failures are caught while admin config keeps the write gate observable", async () => {
  const uid = "web-admin-1";
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    webWriteEnabled: "true",
    queryGetError: {
      collectionName: "wine_packaging",
      message: "wine_packaging unavailable",
    },
  });

  const config = await loaded.main({ action: "getAdminConfig" });
  assert.equal(config.ok, true);
  assert.equal(config.config.writeEnabled, true);
  assert.deepEqual(clone(config.config.homeSectionOrders), {
    banner: [],
    popular: [],
    latest: [],
  });

  const list = await loaded.main({ action: "listCasesV2" });
  assert.equal(list.ok, false);
  assert.equal(list.code, "SERVER_ERROR");
  assert.equal(list.message, "wine_packaging unavailable");
});

await test("web cleanup cannot target another administrator upload directory", async () => {
  const uid = "web-admin-1";
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    webWriteEnabled: "true",
  });
  const result = await loaded.main({
    action: "cleanupUnreferencedFiles",
    fileIDs: [
      "cloud://env/wine-packaging/admin-web/other-admin/batch-1/source.jpg",
    ],
  });
  assert.equal(result.code, "INVALID_CLEANUP_PATH");
  assert.deepEqual(loaded.deletedFiles, []);
});

await test("listCasesV2 returns an exact filtered total beyond 300 records", async () => {
  const cases = Array.from({ length: 350 }, (_, index) => ({
    _id: `case_${index}`,
    caseId: `case_${String(index + 1).padStart(3, "0")}`,
    title: index % 2 ? "青花礼盒" : "商务瓶标",
    packageTypes: { values: [index % 2 ? "礼盒" : "瓶标"] },
    isVisible: true,
    sortOrder: 1,
  }));
  const { main } = loadCaseAdminFunction({ cases });
  const result = await main({
    action: "listCasesV2",
    page: 2,
    pageSize: 50,
    filters: { packageTypes: ["礼盒"], trash: false },
  });
  assert.equal(result.ok, true);
  assert.equal(result.total, 175);
  assert.equal(result.items.length, 50);
  assert.equal(result.hasMore, true);
  assert.equal(
    result.items[0].caseId.localeCompare(result.items.at(-1).caseId) <= 0,
    true
  );
});

await test("web create is hidden-incomplete capable, transactionally numbered and idempotent", async () => {
  const uid = "web-admin-1";
  const source = `cloud://env/wine-packaging/admin-web/${uid}/batch-1/source.jpg`;
  const options = {
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    webWriteEnabled: "true",
    cases: [{ _id: "old", caseId: "case_098", sortOrder: 98 }],
  };
  const loaded = loadCaseAdminFunction(options);
  const event = {
    action: "createCase",
    clientMutationId: "upload-task-1",
    case: {
      title: "待补标签案例",
      packageTypes: [],
      ...buildVariantSet(source),
      isVisible: false,
    },
  };
  const created = await loaded.main(event);
  const replay = await loaded.main(event);
  assert.equal(created.ok, true);
  assert.equal(created.caseId, "case_099");
  assert.equal(created.version, 1);
  assert.equal(replay.ok, true);
  assert.equal(replay.id, created.id);
  assert.equal(replay.duplicate, true);
  assert.equal(
    loaded.collections.wine_packaging.filter((item) => item.clientMutationId === "upload-task-1").length,
    1
  );
  assert.equal(loaded.collections.catalog_meta[0].nextCaseNumber, 100);
});

await test("web create bumps catalog revision once per upload batch while numbering every case", async () => {
  const uid = "web-admin-1";
  const source = `cloud://env/wine-packaging/admin-web/${uid}/batch-1/source.jpg`;
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    webWriteEnabled: "true",
    catalogMeta: [{ _id: "current", revision: 8, nextCaseNumber: 21 }],
  });
  const create = (clientMutationId, uploadBatchId) => loaded.main({
    action: "createCase",
    clientMutationId,
    uploadBatchId,
    case: {
      title: `案例 ${clientMutationId}`,
      packageTypes: [],
      ...buildVariantSet(source),
      isVisible: false,
    },
  });

  const first = await create("mutation-1", "upload-batch-1");
  const second = await create("mutation-2", "upload-batch-1");
  const replay = await create("mutation-2", "upload-batch-1");
  const third = await create("mutation-3", "upload-batch-2");

  assert.equal(first.caseId, "case_021");
  assert.equal(second.caseId, "case_022");
  assert.equal(third.caseId, "case_023");
  assert.equal(replay.duplicate, true);
  assert.equal(loaded.collections.catalog_meta.find((item) => item._id === "current").revision, 10);
  assert.equal(loaded.collections.catalog_meta.find((item) => item._id === "current").nextCaseNumber, 24);
  assert.equal(
    loaded.collections.catalog_meta.filter((item) => item._id.startsWith("upload_batch_")).length,
    2
  );
});

await test("web create transaction failure leaves no upload batch claim", async () => {
  const uid = "web-admin-1";
  const source = `cloud://env/wine-packaging/admin-web/${uid}/batch-1/source.jpg`;
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    webWriteEnabled: "true",
    catalogMeta: [{ _id: "current", revision: 8, nextCaseNumber: 21 }],
    transactionFailureAt: 1,
  });
  const result = await loaded.main({
    action: "createCase",
    clientMutationId: "mutation-failed",
    uploadBatchId: "upload-batch-failed",
    case: {
      title: "失败案例",
      packageTypes: [],
      ...buildVariantSet(source),
      isVisible: false,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(loaded.collections.wine_packaging.length, 0);
  assert.equal(
    loaded.collections.catalog_meta.filter((item) => item._id.startsWith("upload_batch_")).length,
    0
  );
});

await test("web create validates an explicit upload batch id", async () => {
  const uid = "web-admin-1";
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    webWriteEnabled: "true",
  });
  const result = await loaded.main({
    action: "createCase",
    clientMutationId: "mutation-valid",
    uploadBatchId: "invalid/batch",
    case: { title: "不会创建", packageTypes: [], isVisible: false },
  });

  assert.equal(result.code, "INVALID_UPLOAD_BATCH_ID");
  assert.equal(loaded.collections.wine_packaging.length, 0);
});

await test("web create rejects arbitrary cloud files that are not source-bound variants", async () => {
  const uid = "web-admin-1";
  const source =
    `cloud://env/wine-packaging/admin-web/${uid}/batch-1/source.jpg`;
  const variants = buildVariantSet(source);
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    webWriteEnabled: "true",
  });
  const result = await loaded.main({
    action: "createCase",
    clientMutationId: "forged-cloud-file",
    case: {
      title: "伪造图片案例",
      packageTypes: [],
      ...variants,
      galleryImages: ["cloud://env/private/another-business-file.jpg"],
      coverImage: "cloud://env/private/another-business-file.jpg",
      isVisible: false,
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_IMAGE_VARIANTS");
  assert.equal(loaded.collections.wine_packaging.length, 0);
});

await test("web create fails closed without a task id or transaction support", async () => {
  const uid = "web-admin-1";
  const base = {
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    webWriteEnabled: "true",
  };
  const noTask = loadCaseAdminFunction(base);
  const missing = await noTask.main({
    action: "createCase",
    case: { title: "案例", packageTypes: [], isVisible: false },
  });
  assert.equal(missing.code, "MUTATION_ID_REQUIRED");

  const noTransaction = loadCaseAdminFunction({ ...base, transactions: false });
  const source =
    `cloud://env/wine-packaging/admin-web/${uid}/batch-1/source.jpg`;
  const failed = await noTransaction.main({
    action: "createCase",
    clientMutationId: "task-no-transaction",
    case: {
      title: "案例",
      packageTypes: [],
      ...buildVariantSet(source),
      isVisible: false,
    },
  });
  assert.equal(failed.code, "CASE_NUMBER_RESERVATION_FAILED");
  assert.equal(noTransaction.collections.wine_packaging.length, 0);
});

await test("web update preserves unchanged legacy sources and rejects newly added foreign paths", async () => {
  const uid = "web-admin-1";
  const legacySource = "cloud://env/wine-packaging/mobile/legacy/source.jpg";
  const baseCase = {
    _id: "legacy",
    title: "历史案例",
    caseId: "case_001",
    coverImage: "cloud://env/display.jpg",
    galleryImages: ["cloud://env/display.jpg"],
    sourceGalleryImages: [legacySource],
    packageTypes: { values: ["礼盒"] },
    isVisible: false,
    version: 2,
  };
  const options = {
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    webWriteEnabled: "true",
    cases: [baseCase],
  };
  const preserved = loadCaseAdminFunction(options);
  const saved = await preserved.main({
    action: "updateCase",
    id: "legacy",
    expectedVersion: 2,
    case: { title: "历史案例已编辑", sourceGalleryImages: [legacySource] },
  });
  assert.equal(saved.ok, true);

  const rejected = loadCaseAdminFunction(options);
  const bad = await rejected.main({
    action: "updateCase",
    id: "legacy",
    expectedVersion: 2,
    case: {
      sourceGalleryImages: [
        legacySource,
        "cloud://env/wine-packaging/admin-web/another-admin/batch/source.jpg",
      ],
    },
  });
  assert.equal(bad.code, "INVALID_UPLOAD_PATH");
});

await test("updateCase recomputes image changes from the transaction snapshot", async () => {
  const oldImage = "cloud://env/wine-packaging/cases/old.jpg";
  const currentImage = "cloud://env/wine-packaging/cases/current.jpg";
  let firstCaseRead = true;
  const loaded = loadCaseAdminFunction({
    purgeJobs: [{
      _id: "purge_guard_current",
      status: "active",
      activeJobId: `purge_${"e".repeat(40)}`,
      activeRunToken: "active-run",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    }],
    cases: [{
      _id: "stale-mini-update",
      title: "旧标题",
      caseId: "case_901",
      coverImage: oldImage,
      galleryImages: [oldImage],
      packageTypes: { values: ["礼盒"] },
      isVisible: false,
      version: 1,
    }],
    documentGetHook({ collectionName, id, records }) {
      if (
        firstCaseRead
        && collectionName === "wine_packaging"
        && id === "stale-mini-update"
      ) {
        firstCaseRead = false;
        const current = records.find((item) => item._id === id);
        current.coverImage = currentImage;
        current.galleryImages = [currentImage];
        current.version = 2;
      }
    },
  });
  const result = await loaded.main({
    action: "updateCase",
    id: "stale-mini-update",
    case: {
      title: "陈旧全量保存",
      coverImage: oldImage,
      galleryImages: [oldImage],
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "PURGE_CLEANUP_IN_PROGRESS");
  const stored = loaded.collections.wine_packaging.find(
    (item) => item._id === "stale-mini-update"
  );
  assert.equal(stored.coverImage, currentImage);
  assert.deepEqual(stored.galleryImages, [currentImage]);
});

await test("updateCase cleans removed images from the committed transaction snapshot", async () => {
  const outerImage = "cloud://env/wine-packaging/cases/outer.jpg";
  const currentImage = "cloud://env/wine-packaging/cases/transaction-current.jpg";
  const nextImage = "cloud://env/wine-packaging/cases/transaction-next.jpg";
  const sourceImage = "cloud://env/wine-packaging/admin/source.jpg";
  let firstCaseRead = true;
  const loaded = loadCaseAdminFunction({
    cases: [{
      _id: "transaction-cleanup",
      title: "事务废图清理",
      caseId: "case_904",
      coverImage: outerImage,
      galleryImages: [outerImage],
      sourceGalleryImages: [sourceImage],
      packageTypes: { values: ["礼盒"] },
      isVisible: false,
      version: 1,
    }],
    documentGetHook({ collectionName, id, records }) {
      if (
        firstCaseRead
        && collectionName === "wine_packaging"
        && id === "transaction-cleanup"
      ) {
        firstCaseRead = false;
        const current = records.find((item) => item._id === id);
        current.coverImage = currentImage;
        current.galleryImages = [currentImage];
        current.version = 2;
      }
    },
  });
  const result = await loaded.main({
    action: "updateCase",
    id: "transaction-cleanup",
    case: { coverImage: nextImage, galleryImages: [nextImage] },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(loaded.deletedFiles, [currentImage]);
  assert.equal(loaded.deletedFiles.includes(outerImage), false);
});

await test("trash cases cannot be edited or published outside restoreCases", async () => {
  const item = {
    _id: "trashed",
    title: "回收案例",
    coverImage: "cloud://env/case.jpg",
    galleryImages: ["cloud://env/case.jpg"],
    packageTypes: { values: ["礼盒"] },
    deletedAt: "2026-07-30",
    version: 2,
  };
  const { main } = loadCaseAdminFunction({ cases: [item] });
  assert.equal((await main({
    action: "updateCase",
    id: "trashed",
    case: { title: "不应保存" },
  })).code, "CASE_IN_TRASH");
  assert.equal((await main({
    action: "setCaseVisibility",
    id: "trashed",
    isVisible: true,
  })).code, "CASE_IN_TRASH");
});

await test("setCaseVisibility checks expectedVersion inside its transaction", async () => {
  const uid = "web-admin-1";
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    webWriteEnabled: "true",
    cases: [{
      _id: "case_1",
      title: "可上架案例",
      coverImage: "cloud://env/display.jpg",
      galleryImages: ["cloud://env/display.jpg"],
      packageTypes: { values: ["礼盒"] },
      isVisible: false,
      version: 1,
    }],
  });
  const event = {
    action: "setCaseVisibility",
    id: "case_1",
    isVisible: true,
    expectedVersion: 1,
  };
  assert.equal((await loaded.main(event)).ok, true);
  assert.equal((await loaded.main(event)).code, "VERSION_CONFLICT");
  assert.equal(loaded.collections.wine_packaging[0].version, 2);
});

await test("homepage ordering allows one case in multiple sections and validates versions", async () => {
  const uid = "web-admin-1";
  const item = {
    _id: "shared",
    title: "共享首页案例",
    caseId: "case_001",
    coverImage: "cloud://env/display.jpg",
    galleryImages: ["cloud://env/display.jpg"],
    packageTypes: { values: ["礼盒"] },
    isVisible: true,
    version: 5,
  };
  const hiddenReserved = {
    _id: "hidden_reserved",
    title: "隐藏预留案例",
    caseId: "case_002",
    homeSections: { values: ["latest"] },
    homeSectionOrder: { latest: 1 },
    isVisible: false,
    version: 7,
  };
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    webWriteEnabled: "true",
    cases: [item, hiddenReserved],
  });
  const result = await loaded.main({
    action: "setHomeSectionOrder",
    orders: { banner: ["shared"], popular: ["shared"], latest: [] },
    expectedVersions: { shared: 5, hidden_reserved: 7 },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(loaded.collections.wine_packaging[0].homeSections, {
    values: ["banner", "popular"],
  });
  assert.deepEqual(loaded.collections.wine_packaging[0].homeSectionOrder, {
    banner: 1,
    popular: 1,
  });
  assert.deepEqual(loaded.collections.wine_packaging[1].homeSections, { values: [] });
  assert.deepEqual(loaded.collections.wine_packaging[1].homeSectionOrder, {});

  const missingVersion = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    webWriteEnabled: "true",
    cases: [item, hiddenReserved],
  });
  assert.equal((await missingVersion.main({
    action: "setHomeSectionOrder",
    orders: { banner: ["shared"], popular: [], latest: [] },
  })).code, "EXPECTED_VERSION_REQUIRED");
});

await test("homepage ordering rolls back an earlier chunk when more than fifty legacy memberships are cleared", async () => {
  const uid = "web-admin-1";
  const cases = Array.from({ length: 60 }, (_, index) => ({
    _id: `home_${index}`,
    caseId: `case_${String(index + 1).padStart(3, "0")}`,
    title: `历史首页案例 ${index + 1}`,
    coverImage: `cloud://env/display-${index}.jpg`,
    galleryImages: [`cloud://env/display-${index}.jpg`],
    packageTypes: { values: ["礼盒"] },
    homeSections: { values: ["popular"] },
    homeSectionOrder: index < 4 ? { popular: index + 1 } : {},
    isVisible: true,
    version: 1,
  }));
  const originalMemberships = Object.fromEntries(
    cases.map((item) => [
      item._id,
      {
        homeSections: item.homeSections,
        homeSectionOrder: item.homeSectionOrder,
      },
    ])
  );
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    webWriteEnabled: "true",
    cases,
    catalogMeta: [{ _id: "current", revision: 8, nextCaseNumber: 61 }],
    transactionFailureAt: 2,
  });
  const result = await loaded.main({
    action: "setHomeSectionOrder",
    orders: { banner: [], popular: [], latest: [] },
    expectedVersions: Object.fromEntries(cases.map((item) => [item._id, 1])),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "TRANSACTION_FAILED");
  assert.deepEqual(
    Object.fromEntries(
      loaded.collections.wine_packaging.map((item) => [
        item._id,
        {
          homeSections: item.homeSections,
          homeSectionOrder: item.homeSectionOrder,
        },
      ])
    ),
    originalMemberships
  );
  assert.equal(
    loaded.calls.filter((call) => call.type === "transaction").length,
    3
  );
  assert.equal(
    loaded.calls.filter(
      (call) => call.collectionName === "catalog_meta" && call.type === "update"
    ).length,
    0
  );
});

await test("versioned desktop batch writes fail closed without transaction support", async () => {
  const uid = "web-admin-1";
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    webWriteEnabled: "true",
    transactions: false,
    cases: [{
      _id: "doc_1",
      caseId: "case_001",
      title: "事务保护",
      coverImage: "cloud://env/wine-packaging/case-1.jpg",
      packageTypes: { values: ["礼盒"] },
      version: 1,
      isVisible: false,
    }],
  });
  const result = await loaded.main({
    action: "batchPatchCases",
    ids: ["doc_1"],
    patch: { isPinned: true },
    expectedVersions: { doc_1: 1 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "TRANSACTION_UNAVAILABLE");
  assert.equal(loaded.collections.wine_packaging[0].isPinned, undefined);
});

await test("reorderCases chunks 350 versioned updates and bumps revision only once", async () => {
  const uid = "web-admin-1";
  const cases = Array.from({ length: 350 }, (_, index) => ({
    _id: `doc_${index}`,
    caseId: `case_${String(index + 1).padStart(3, "0")}`,
    sortOrder: 1,
    version: 1,
  }));
  const orderedIds = cases.map((item) => item._id).reverse();
  const expectedVersions = Object.fromEntries(cases.map((item) => [item._id, 1]));
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    webWriteEnabled: "true",
    cases,
    catalogMeta: [{ _id: "current", revision: 8, nextCaseNumber: 351 }],
  });
  const result = await loaded.main({
    action: "reorderCases",
    orderedIds,
    expectedVersions,
  });
  assert.equal(result.ok, true);
  assert.equal(result.updated, 350);
  assert.deepEqual(
    loaded.collections.wine_packaging
      .slice()
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map((item) => item.sortOrder),
    Array.from({ length: 350 }, (_, index) => index + 1)
  );
  const transactionCalls = loaded.calls.filter((call) => call.type === "transaction");
  assert.equal(transactionCalls.length, 7);
  const revisionUpdates = loaded.calls.filter(
    (call) => call.collectionName === "catalog_meta" && call.type === "update"
  );
  assert.equal(revisionUpdates.length, 1);
});

await test("reorderCases rolls back committed chunks after an unclassified transaction failure", async () => {
  const uid = "web-admin-1";
  const cases = Array.from({ length: 60 }, (_, index) => ({
    _id: `doc_${index}`,
    caseId: `case_${String(index + 1).padStart(3, "0")}`,
    sortOrder: index + 1,
    version: 1,
  }));
  const originalSortOrders = Object.fromEntries(
    cases.map((item) => [item._id, item.sortOrder])
  );
  const orderedIds = cases.map((item) => item._id).reverse();
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    webWriteEnabled: "true",
    cases,
    catalogMeta: [{ _id: "current", revision: 8, nextCaseNumber: 61 }],
    transactionFailureAt: 2,
  });
  const result = await loaded.main({
    action: "reorderCases",
    orderedIds,
    expectedVersions: Object.fromEntries(cases.map((item) => [item._id, 1])),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "TRANSACTION_FAILED");
  assert.deepEqual(
    Object.fromEntries(
      loaded.collections.wine_packaging.map((item) => [item._id, item.sortOrder])
    ),
    originalSortOrders
  );
  assert.equal(
    loaded.calls.filter((call) => call.type === "transaction").length,
    3
  );
  assert.equal(
    loaded.calls.filter(
      (call) => call.collectionName === "catalog_meta" && call.type === "update"
    ).length,
    0
  );
});

await test("admin config exposes independent activity and permanent-delete feature gates", async () => {
  const uid = "web-admin-1";
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: `${uid},web-admin-2`,
    webWriteEnabled: "true",
    activitySyncEnabled: "true",
    permanentDeleteEnabled: "true",
    adminDisplayNames: '{"web-admin-1":"administrator","web-admin-2":"sharky"}',
  });
  const result = await loaded.main({ action: "getAdminConfig" });
  assert.equal(result.ok, true);
  assert.equal(result.config.activitySyncEnabled, true);
  assert.equal(result.config.permanentDeleteEnabled, true);
  assert.equal(result.config.actorDisplayName, "administrator");
  assert.deepEqual(result.config.options.scenes, [
    "婚宴",
    "百日/满月",
    "生日宴",
    "寿宴",
    "乔迁宴",
    "送礼",
    "商务招待",
    "节庆礼赠",
    "企业纪念",
    "商超陈列",
    "电商展示",
  ]);
});

await test("upload synchronization fans out sanitized activity and remains owner-operated", async () => {
  const uid = "web-admin-1";
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: `${uid},web-admin-2`,
    webWriteEnabled: "true",
    activitySyncEnabled: "true",
    adminDisplayNames: '{"web-admin-1":"administrator","web-admin-2":"sharky"}',
  });
  const registered = await loaded.main({
    action: "registerUploadItems",
    items: [
      {
        mutationId: "upload-one",
        uploadBatchId: "batch-one",
        title: "婚宴案例",
        imageCount: 2,
        packageTypes: ["礼盒"],
        scenes: ["婚宴"],
        status: "waiting",
      },
      {
        mutationId: "upload-two",
        uploadBatchId: "batch-one",
        title: "待移除案例",
        imageCount: 1,
        packageTypes: [],
        scenes: [],
        status: "waiting",
      },
    ],
  });
  assert.equal(registered.ok, true);
  assert.equal(registered.registered, 2);
  assert.equal(loaded.collections.case_admin_upload_jobs.length, 2);
  assert.equal(loaded.collections.case_admin_activity_feed.length, 4);
  assert.equal(
    loaded.collections.case_admin_activity_feed.every(
      (item) => !Object.keys(item).some((key) => /file|blob|url/i.test(key))
    ),
    true
  );
  assert.deepEqual(
    loaded.collections.case_admin_upload_jobs[0].scenes,
    ["婚宴"]
  );

  const replay = await loaded.main({
    action: "registerUploadItems",
    items: [{
      mutationId: "upload-one",
      uploadBatchId: "batch-one",
      title: "婚宴案例",
      imageCount: 2,
      packageTypes: ["礼盒"],
      scenes: ["婚宴"],
      status: "waiting",
    }],
  });
  assert.equal(replay.registered, 0);
  assert.equal(replay.existing, 1);
  assert.equal(loaded.collections.case_admin_activity_feed.length, 4);

  const updated = await loaded.main({
    action: "updateUploadItemStatus",
    mutationId: "upload-one",
    status: "uploading",
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.item.status, "uploading");
  assert.equal(loaded.collections.case_admin_activity_feed.length, 6);

  const busyRemoval = await loaded.main({
    action: "removeUploadItem",
    mutationId: "upload-one",
  });
  assert.equal(busyRemoval.code, "UPLOAD_JOB_BUSY");
  const removed = await loaded.main({
    action: "removeUploadItem",
    mutationId: "upload-two",
  });
  assert.equal(removed.ok, true);
  assert.equal(loaded.collections.case_admin_upload_jobs.length, 2);
  assert.equal(
    loaded.collections.case_admin_upload_jobs.find(
      (item) => item.mutationId === "upload-two"
    ).tombstone,
    true
  );

  const lateRegister = await loaded.main({
    action: "registerUploadItems",
    items: [{
      mutationId: "upload-two",
      uploadBatchId: "batch-one",
      title: "迟到的登记",
      imageCount: 1,
      packageTypes: [],
      scenes: [],
      status: "waiting",
    }],
  });
  assert.equal(lateRegister.registered, 0);
  assert.equal(lateRegister.existing, 0);
  assert.equal(lateRegister.removed, 1);

  const removeBeforeRegister = await loaded.main({
    action: "removeUploadItem",
    mutationId: "remove-before-register",
  });
  assert.equal(removeBeforeRegister.ok, true);
  const blockedLateRegister = await loaded.main({
    action: "registerUploadItems",
    items: [{
      mutationId: "remove-before-register",
      uploadBatchId: "batch-one",
      title: "不应重建",
      imageCount: 1,
      packageTypes: [],
      scenes: [],
      status: "waiting",
    }],
  });
  assert.equal(blockedLateRegister.removed, 1);
  assert.equal((await loaded.main({
    action: "updateUploadItemStatus",
    mutationId: "remove-before-register",
    status: "uploading",
  })).code, "UPLOAD_JOB_REMOVED");

  assert.equal((await loaded.main({
    action: "updateUploadItemStatus",
    mutationId: "upload-one",
    status: "creating",
  })).ok, true);
  assert.equal((await loaded.main({
    action: "updateUploadItemStatus",
    mutationId: "upload-one",
    status: "processing",
  })).code, "INVALID_UPLOAD_STATUS_TRANSITION");
  assert.equal((await loaded.main({
    action: "updateUploadItemStatus",
    mutationId: "upload-one",
    status: "failed",
  })).ok, true);
  assert.equal((await loaded.main({
    action: "updateUploadItemStatus",
    mutationId: "upload-one",
    status: "processing",
  })).ok, true);
  assert.equal((await loaded.main({
    action: "updateUploadItemStatus",
    mutationId: "upload-one",
    status: "done",
  })).ok, true);
  assert.equal((await loaded.main({
    action: "updateUploadItemStatus",
    mutationId: "upload-one",
    status: "failed",
  })).code, "INVALID_UPLOAD_STATUS_TRANSITION");

  const shared = await loaded.main({ action: "listSharedUploadItems", limit: 50 });
  const activity = await loaded.main({ action: "listAdminActivity", limit: 50 });
  assert.equal(shared.items.length, 1);
  assert.equal(activity.items.every((item) => item.viewerUid === uid), true);
  assert.equal(activity.items.some((item) => item.action === "upload_removed"), true);
});

await test("shared upload listing scans past tombstones without returning them", async () => {
  const uid = "web-admin-1";
  const tombstones = Array.from({ length: 120 }, (_, index) => ({
    _id: `upload-0${String(index).padStart(3, "0")}`,
    mutationId: `removed-${index}`,
    ownerUid: uid,
    status: "removed",
    tombstone: true,
    updatedAt: "2099-01-01T00:00:00.000Z",
  }));
  const active = Array.from({ length: 60 }, (_, index) => ({
    // The ten newest rows deliberately sort after the old rows by _id. A hash
    // cursor that fills the limit first would miss them.
    _id: index >= 50
      ? `upload-z${String(index).padStart(3, "0")}`
      : `upload-b${String(index).padStart(3, "0")}`,
    mutationId: `active-${index}`,
    ownerUid: uid,
    status: index % 2 ? "processing" : "waiting",
    updatedAt: new Date(Date.UTC(
      2026,
      index >= 50 ? 7 : 0,
      1,
      0,
      index
    )).toISOString(),
  }));
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    webWriteEnabled: "true",
    activitySyncEnabled: "true",
    uploadJobs: tombstones.concat(active),
  });
  const result = await loaded.main({ action: "listSharedUploadItems", limit: 50 });
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 50);
  assert.equal(result.items[0].mutationId, "active-59");
  assert.equal(result.items.some((item) => item.mutationId === "active-50"), true);
  assert.equal(result.items.some((item) => item.mutationId === "active-0"), false);
  assert.equal(
    result.items.some((item) => item.tombstone === true || item.status === "removed"),
    false
  );
  assert.equal(
    loaded.calls.some(
      (call) => call.collectionName === "case_admin_upload_jobs"
        && call.type === "skip"
        && call.value === 100
    ),
    true
  );
});

await test("activity fanout repairs missing viewer copies on idempotent replays", async () => {
  const uid = "web-admin-1";
  let failSecondViewerOnce = true;
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: `${uid},web-admin-2`,
    webWriteEnabled: "true",
    activitySyncEnabled: "true",
    documentSetHook({ collectionName, payload }) {
      if (
        failSecondViewerOnce
        && collectionName === "case_admin_activity_feed"
        && payload.data.viewerUid === "web-admin-2"
      ) {
        failSecondViewerOnce = false;
        throw new Error("single viewer write failed");
      }
    },
  });
  const registration = {
    action: "registerUploadItems",
    items: [{
      mutationId: "fanout-repair",
      uploadBatchId: "batch-fanout",
      title: "动态修复",
      imageCount: 1,
      packageTypes: [],
      scenes: [],
      status: "waiting",
    }],
  };
  assert.equal((await loaded.main(registration)).ok, true);
  assert.equal(loaded.collections.case_admin_activity_feed.length, 2);
  assert.equal(
    loaded.collections.case_admin_activity_feed.some(
      (item) => item.viewerUid === "__server_outbox__" && item.serverOutbox === true
    ),
    true
  );
  const replay = await loaded.main(registration);
  assert.equal(replay.ok, true);
  assert.equal(replay.existing, 1);
  assert.equal(loaded.collections.case_admin_activity_feed.length, 2);

  const statusEvent = {
    action: "updateUploadItemStatus",
    mutationId: "fanout-repair",
    status: "uploading",
  };
  assert.equal((await loaded.main(statusEvent)).ok, true);
  const missingIndex = loaded.collections.case_admin_activity_feed.findIndex(
    (item) => item.action === "upload_started" && item.viewerUid === "web-admin-2"
  );
  assert.notEqual(missingIndex, -1);
  loaded.collections.case_admin_activity_feed.splice(missingIndex, 1);
  assert.equal((await loaded.main(statusEvent)).ok, true);
  const uploadStarted = loaded.collections.case_admin_activity_feed.filter(
    (item) => item.action === "upload_started"
  );
  assert.equal(uploadStarted.length, 2);
  assert.equal(new Set(uploadStarted.map((item) => item.viewerUid)).size, 2);
});

await test("server case mutations create deterministic shared activities", async () => {
  const uid = "web-admin-1";
  const source = `cloud://env/wine-packaging/admin-web/${uid}/batch-live/source.jpg`;
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: `${uid},web-admin-2`,
    webWriteEnabled: "true",
    activitySyncEnabled: "true",
    catalogMeta: [{ _id: "current", revision: 1, nextCaseNumber: 1 }],
  });
  await loaded.main({
    action: "registerUploadItems",
    items: [{
      mutationId: "live-task",
      uploadBatchId: "batch-live",
      title: "同步案例",
      imageCount: 1,
      packageTypes: [],
      scenes: ["送礼"],
      status: "waiting",
    }],
  });
  const created = await loaded.main({
    action: "createCase",
    clientMutationId: "live-task",
    uploadBatchId: "batch-live",
    case: {
      title: "同步案例",
      packageTypes: [],
      scenes: ["送礼"],
      ...buildVariantSet(source),
      isVisible: false,
    },
  });
  assert.equal(created.ok, true);
  assert.equal(loaded.collections.case_admin_upload_jobs[0].status, "needs_tags");
  assert.equal(
    loaded.collections.case_admin_activity_feed.filter(
      (item) => item.action === "case_created"
    ).length,
    2
  );

  const moved = await loaded.main({
    action: "moveCasesToTrash",
    ids: [created.id],
    expectedVersions: { [created.id]: 1 },
  });
  const restored = await loaded.main({
    action: "restoreCases",
    ids: [created.id],
    expectedVersions: { [created.id]: moved.versions[created.id] },
  });
  assert.equal(restored.ok, true);
  const actions = loaded.collections.case_admin_activity_feed.map((item) => item.action);
  assert.equal(actions.includes("case_moved_to_trash"), true);
  assert.equal(actions.includes("case_restored"), true);
});

await test("case activity outbox repairs partial fanout from both polling endpoints", async () => {
  const uid = "web-admin-1";
  let failAction = "case_moved_to_trash";
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: `${uid},web-admin-2`,
    webWriteEnabled: "true",
    activitySyncEnabled: "true",
    cases: [{
      _id: "case-outbox",
      title: "案例动态补偿",
      caseId: "case_906",
      packageTypes: { values: ["礼盒"] },
      isVisible: false,
      version: 1,
    }],
    documentSetHook({ collectionName, payload }) {
      if (
        failAction
        && collectionName === "case_admin_activity_feed"
        && payload.data.viewerUid === "web-admin-2"
        && payload.data.action === failAction
      ) {
        failAction = "";
        throw new Error("viewer copy temporarily unavailable");
      }
    },
  });
  const moved = await loaded.main({
    action: "moveCasesToTrash",
    ids: ["case-outbox"],
    expectedVersions: { "case-outbox": 1 },
  });
  assert.equal(moved.ok, true);
  const firstOutbox = loaded.collections.case_admin_activity_feed.find(
    (item) => item.viewerUid === "__server_outbox__"
  );
  assert.equal(firstOutbox.serverOutbox, true);
  assert.equal(
    Object.keys(firstOutbox).some((key) => /file|blob|url/i.test(key)),
    false
  );
  assert.equal(JSON.stringify(firstOutbox).includes("cloud://"), false);

  assert.equal((await loaded.main({
    action: "listSharedUploadItems",
    limit: 50,
  })).ok, true);
  assert.equal(
    loaded.collections.case_admin_activity_feed.some(
      (item) => item.viewerUid === "__server_outbox__"
    ),
    false
  );
  assert.equal(
    loaded.collections.case_admin_activity_feed.filter(
      (item) => item.action === "case_moved_to_trash"
    ).length,
    2
  );

  failAction = "case_restored";
  const restored = await loaded.main({
    action: "restoreCases",
    ids: ["case-outbox"],
    expectedVersions: { "case-outbox": moved.versions["case-outbox"] },
  });
  assert.equal(restored.ok, true);
  assert.equal(
    loaded.collections.case_admin_activity_feed.some(
      (item) => item.viewerUid === "__server_outbox__"
    ),
    true
  );
  const activity = await loaded.main({ action: "listAdminActivity", limit: 50 });
  assert.equal(activity.ok, true);
  assert.equal(
    loaded.collections.case_admin_activity_feed.some(
      (item) => item.viewerUid === "__server_outbox__"
    ),
    false
  );
  for (const action of ["case_moved_to_trash", "case_restored"]) {
    const copies = loaded.collections.case_admin_activity_feed.filter(
      (item) => item.action === action
    );
    assert.equal(copies.length, 2);
    assert.equal(new Set(copies.map((item) => item.viewerUid)).size, 2);
  }
  await loaded.main({ action: "listSharedUploadItems", limit: 50 });
  await loaded.main({ action: "listAdminActivity", limit: 50 });
  assert.equal(loaded.collections.case_admin_activity_feed.length, 4);
});

await test("permanent delete prevalidates the full batch and safely removes only unreferenced files", async () => {
  const uid = "web-admin-1";
  const unused = "cloud://env/wine-packaging/admin-web/old/batch/unused.jpg";
  const shared = "cloud://env/wine-packaging/admin-web/old/batch/shared.jpg";
  const bannerShared = "cloud://env/wine-packaging/variants/v2/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/banner.jpg";
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: `${uid},web-admin-2`,
    webWriteEnabled: "true",
    activitySyncEnabled: "true",
    permanentDeleteEnabled: "true",
    cases: [
      {
        _id: "trash-one",
        title: "永久删除案例",
        caseId: "case_001",
        coverImage: unused,
        galleryImages: [unused, shared],
        sourceGalleryImages: [shared],
        galleryBanners: [bannerShared],
        deletedAt: "2026-08-01",
        version: 3,
      },
      {
        _id: "active-one",
        title: "保留引用",
        coverImage: shared,
        galleryImages: [shared],
        isVisible: true,
        version: 1,
      },
    ],
    banners: [{ _id: "banner-one", image: bannerShared, isVisible: false }],
  });
  const event = {
    action: "permanentlyDeleteCases",
    ids: ["trash-one"],
    expectedVersions: { "trash-one": 3 },
    clientMutationId: "purge-task-one",
  };
  const result = await loaded.main(event);
  assert.equal(result.ok, true);
  assert.equal(result.deleted, 1);
  assert.equal(result.deletedFileCount, 1);
  assert.equal(result.retainedReferencedCount, 2);
  assert.equal(result.pendingFileCount, 0);
  assert.deepEqual(loaded.deletedFiles, [unused]);
  assert.equal(
    loaded.collections.wine_packaging.some((item) => item._id === "trash-one"),
    false
  );
  assert.equal(
    loaded.collections.case_admin_purge_jobs.filter(
      (item) => item._id !== "purge_guard_current"
    ).length,
    1
  );
  assert.equal(
    loaded.collections.case_admin_purge_jobs.find(
      (item) => item._id === "purge_guard_current"
    ).status,
    "idle"
  );
  assert.equal(
    loaded.collections.case_admin_activity_feed.filter(
      (item) => item.action === "case_permanently_deleted"
    ).length,
    2
  );

  const replay = await loaded.main(event);
  assert.equal(replay.ok, true);
  assert.equal(replay.deletedFileCount, 1);
  assert.deepEqual(loaded.deletedFiles, [unused]);
});

await test("permanent delete leaves every case untouched on validation failure", async () => {
  const uid = "web-admin-1";
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    webWriteEnabled: "true",
    permanentDeleteEnabled: "true",
    cases: [
      { _id: "trash", deletedAt: "2026-08-01", version: 2 },
      { _id: "active", deletedAt: null, version: 1 },
    ],
  });
  const mixed = await loaded.main({
    action: "permanentlyDeleteCases",
    ids: ["trash", "active"],
    expectedVersions: { trash: 2, active: 1 },
    clientMutationId: "purge-mixed",
  });
  assert.equal(mixed.code, "CASE_NOT_IN_TRASH");
  assert.equal(loaded.collections.wine_packaging.length, 2);
  assert.equal(loaded.collections.case_admin_purge_jobs.length, 0);

  const conflict = await loaded.main({
    action: "permanentlyDeleteCases",
    ids: ["trash"],
    expectedVersions: { trash: 1 },
    clientMutationId: "purge-conflict",
  });
  assert.equal(conflict.code, "VERSION_CONFLICT");
  assert.equal(loaded.collections.wine_packaging.length, 2);
});

await test("permanent delete never removes files outside approved case namespaces", async () => {
  const uid = "web-admin-1";
  const allowed = "cloud://env/wine-packaging/cases/case_902.jpg";
  const external = "cloud://env/customer-uploads/invoice.jpg";
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    webWriteEnabled: "true",
    permanentDeleteEnabled: "true",
    cases: [{
      _id: "trash-path-whitelist",
      title: "路径白名单",
      caseId: "case_902",
      coverImage: allowed,
      galleryImages: [allowed, external],
      deletedAt: "2026-08-01",
      version: 2,
    }],
  });
  const result = await loaded.main({
    action: "permanentlyDeleteCases",
    ids: ["trash-path-whitelist"],
    expectedVersions: { "trash-path-whitelist": 2 },
    clientMutationId: "purge-path-whitelist",
  });
  assert.equal(result.ok, true);
  assert.equal(result.deletedFileCount, 1);
  assert.equal(result.retainedReferencedCount, 1);
  assert.equal(result.pendingFileCount, 0);
  assert.deepEqual(loaded.deletedFiles, [allowed]);
  assert.equal(loaded.deletedFiles.includes(external), false);
});

await test("failed purge cleanup remains retryable without recreating the deleted case", async () => {
  const uid = "web-admin-1";
  const fileID = "cloud://env/wine-packaging/admin-web/old/batch/retry.jpg";
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    webWriteEnabled: "true",
    permanentDeleteEnabled: "true",
    deleteFileFailureAt: 1,
    cases: [{
      _id: "trash-retry",
      title: "待重试",
      caseId: "case_009",
      coverImage: fileID,
      deletedAt: "2026-08-01",
      version: 4,
    }],
  });
  const first = await loaded.main({
    action: "permanentlyDeleteCases",
    ids: ["trash-retry"],
    expectedVersions: { "trash-retry": 4 },
    clientMutationId: "purge-retry",
  });
  assert.equal(first.ok, true);
  assert.equal(first.status, "cleanup_release_pending");
  assert.equal(first.pendingFileCount, 1);
  assert.equal(first.deletedFileCount, 0);
  assert.deepEqual(loaded.deletedFiles, []);
  assert.equal(loaded.collections.wine_packaging.length, 0);
  const heldGuard = loaded.collections.case_admin_purge_jobs.find(
    (item) => item._id === "purge_guard_current"
  );
  assert.equal(heldGuard.status, "active");
  heldGuard.leaseExpiresAt = "2000-01-01T00:00:00.000Z";
  const retried = await loaded.main({
    action: "retryPurgeCleanup",
    jobId: first.cleanupJobId,
  });
  assert.equal(retried.ok, true);
  assert.equal(retried.pendingFileCount, 0);
  assert.equal(retried.deletedFileCount, 1);
  assert.deepEqual(loaded.deletedFiles, [fileID]);
});

await test("the same purge job cannot run two cleanup attempts concurrently", async () => {
  const uid = "web-admin-1";
  const jobId = `purge_${"c".repeat(40)}`;
  const fileID = "cloud://env/wine-packaging/admin-web/old/batch/concurrent.jpg";
  let signalDeleteStarted;
  const deleteStarted = new Promise((resolveStarted) => {
    signalDeleteStarted = resolveStarted;
  });
  let unblockDelete;
  const deleteBlocked = new Promise((resolveBlocked) => {
    unblockDelete = resolveBlocked;
  });
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    webWriteEnabled: "true",
    permanentDeleteEnabled: "true",
    purgeJobs: [{
      _id: jobId,
      actor: { type: "cloudbase_uid", id: uid },
      deletedCaseCount: 1,
      candidateFileIds: [fileID],
      pendingFileIds: [fileID],
      deletedFileIds: [],
      retainedReferencedFileIds: [],
      status: "cleanup_pending",
    }],
    async deleteFileHook({ callCount }) {
      if (callCount !== 1) return;
      signalDeleteStarted();
      await deleteBlocked;
    },
  });

  const firstAttempt = loaded.main({
    action: "retryPurgeCleanup",
    jobId,
  });
  await deleteStarted;
  const concurrentAttempt = await loaded.main({
    action: "retryPurgeCleanup",
    jobId,
  });
  assert.equal(concurrentAttempt.ok, false);
  assert.equal(concurrentAttempt.code, "PURGE_CLEANUP_BUSY");
  assert.deepEqual(loaded.deletedFiles, []);

  unblockDelete();
  const completed = await firstAttempt;
  assert.equal(completed.ok, true);
  assert.equal(completed.pendingFileCount, 0);
  assert.deepEqual(loaded.deletedFiles, [fileID]);
  const guard = loaded.collections.case_admin_purge_jobs.find(
    (item) => item._id === "purge_guard_current"
  );
  assert.equal(guard.status, "idle");
  assert.equal(guard.activeRunToken, "");
});

await test("a failed token-matched guard release stays pending and recovers after lease expiry", async () => {
  const uid = "web-admin-1";
  const jobId = `purge_${"d".repeat(40)}`;
  const fileID = "cloud://env/wine-packaging/admin-web/old/batch/release.jpg";
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    webWriteEnabled: "true",
    permanentDeleteEnabled: "true",
    transactionFailureAt: 3,
    purgeJobs: [{
      _id: jobId,
      actor: { type: "cloudbase_uid", id: uid },
      deletedCaseCount: 1,
      candidateFileIds: [fileID],
      pendingFileIds: [fileID],
      deletedFileIds: [],
      retainedReferencedFileIds: [],
      status: "cleanup_pending",
    }],
  });

  const releaseFailed = await loaded.main({
    action: "retryPurgeCleanup",
    jobId,
  });
  assert.equal(releaseFailed.ok, true);
  assert.equal(releaseFailed.pendingFileCount, 1);
  assert.equal(releaseFailed.status, "cleanup_release_pending");
  assert.equal(releaseFailed.cleanupDeferred, true);
  assert.equal(releaseFailed.guardReleasePending, true);
  assert.deepEqual(loaded.deletedFiles, [fileID]);
  const pendingJob = loaded.collections.case_admin_purge_jobs.find(
    (item) => item._id === jobId
  );
  assert.equal(pendingJob.status, "cleanup_release_pending");
  assert.equal(pendingJob.guardReleasePending, true);
  const guard = loaded.collections.case_admin_purge_jobs.find(
    (item) => item._id === "purge_guard_current"
  );
  assert.equal(guard.status, "active");
  assert.equal(typeof guard.activeRunToken, "string");
  assert.equal(guard.activeRunToken.length > 0, true);

  const beforeExpiry = await loaded.main({
    action: "retryPurgeCleanup",
    jobId,
  });
  assert.equal(beforeExpiry.ok, false);
  assert.equal(beforeExpiry.code, "PURGE_CLEANUP_BUSY");

  guard.leaseExpiresAt = "2000-01-01T00:00:00.000Z";
  const recovered = await loaded.main({
    action: "retryPurgeCleanup",
    jobId,
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.pendingFileCount, 0);
  assert.equal(recovered.status, "completed");
  assert.deepEqual(loaded.deletedFiles, [fileID]);
  const releasedGuard = loaded.collections.case_admin_purge_jobs.find(
    (item) => item._id === "purge_guard_current"
  );
  assert.equal(releasedGuard.status, "idle");
  assert.equal(releasedGuard.activeRunToken, "");
});

await test("pending purge jobs can be recovered without exposing cloud file ids", async () => {
  const uid = "web-admin-1";
  const fileID = "cloud://env/wine-packaging/admin-web/old/batch/lost-response.jpg";
  const mutationId = "purge-lost-response";
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: `${uid},web-admin-2`,
    webWriteEnabled: "true",
    permanentDeleteEnabled: "true",
    deleteFileFailureAt: 1,
    cases: [{
      _id: "trash-lost-response",
      title: "响应丢失测试",
      caseId: "case_812",
      coverImage: fileID,
      deletedAt: "2026-08-01",
      version: 7,
    }],
  });

  // Treat this response as lost: recovery only knows the original mutation id.
  await loaded.main({
    action: "permanentlyDeleteCases",
    ids: ["trash-lost-response"],
    expectedVersions: { "trash-lost-response": 7 },
    clientMutationId: mutationId,
  });
  const recoveredList = await loaded.main({
    action: "listPendingPurgeJobs",
    clientMutationId: mutationId,
  });
  assert.equal(recoveredList.ok, true);
  assert.equal(recoveredList.items.length, 1);
  const recoveredJob = recoveredList.items[0];
  assert.match(recoveredJob.cleanupJobId, /^purge_[a-f0-9]{40}$/);
  assert.equal(recoveredJob.pendingFileCount, 1);
  assert.equal(recoveredJob.caseSummaries[0].title, "响应丢失测试");
  assert.equal(JSON.stringify(recoveredJob).includes("cloud://"), false);
  for (const key of [
    "candidateFileIds",
    "pendingFileIds",
    "deletedFileIds",
    "retainedReferencedFileIds",
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(recoveredJob, key), false);
  }

  const otherAdmin = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid: "web-admin-2", openId: "", isAnonymous: false },
    adminUids: `${uid},web-admin-2`,
    webWriteEnabled: "true",
    permanentDeleteEnabled: "true",
    purgeJobs: loaded.collections.case_admin_purge_jobs,
  });
  const sharedRecoveryList = await otherAdmin.main({
    action: "listPendingPurgeJobs",
  });
  assert.equal(sharedRecoveryList.ok, true);
  assert.equal(sharedRecoveryList.items.length, 1);
  assert.equal(sharedRecoveryList.items[0].cleanupJobId, recoveredJob.cleanupJobId);
  assert.equal(JSON.stringify(sharedRecoveryList.items[0]).includes("cloud://"), false);

  loaded.collections.case_admin_purge_jobs.find(
    (item) => item._id === "purge_guard_current"
  ).leaseExpiresAt = "2000-01-01T00:00:00.000Z";
  const retried = await loaded.main({
    action: "retryPurgeCleanup",
    jobId: recoveredJob.cleanupJobId,
  });
  assert.equal(retried.ok, true);
  assert.equal(retried.pendingFileCount, 0);
  const completedList = await loaded.main({
    action: "listPendingPurgeJobs",
    clientMutationId: mutationId,
  });
  assert.equal(completedList.ok, true);
  assert.equal(completedList.items.length, 0);
});

await test("stable cursor reference scans do not skip a shared file when rows disappear between pages", async () => {
  const uid = "web-admin-1";
  const shared = "cloud://env/wine-packaging/admin-web/old/batch/cursor-shared.jpg";
  const activeCases = Array.from({ length: 101 }, (_, index) => ({
    _id: `active-${String(index).padStart(3, "0")}`,
    title: `活动案例 ${index}`,
    coverImage: index === 100 ? shared : `cloud://env/active-${index}.jpg`,
    galleryImages: index === 100 ? [shared] : [`cloud://env/active-${index}.jpg`],
    version: 1,
  }));
  let mutated = false;
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    webWriteEnabled: "true",
    permanentDeleteEnabled: "true",
    cases: [{
      _id: "trash-cursor",
      title: "游标删除",
      caseId: "case_700",
      coverImage: shared,
      galleryImages: [shared],
      deletedAt: "2026-08-01",
      version: 2,
    }, ...activeCases],
    queryGetHook({ collectionName, condition, records, data }) {
      if (
        !mutated
        && collectionName === "wine_packaging"
        && !condition._id
        && data.length === 100
      ) {
        mutated = true;
        const index = records.findIndex((item) => item._id === "active-000");
        records.splice(index, 1);
      }
    },
  });
  const result = await loaded.main({
    action: "permanentlyDeleteCases",
    ids: ["trash-cursor"],
    expectedVersions: { "trash-cursor": 2 },
    clientMutationId: "purge-cursor",
  });
  assert.equal(result.ok, true);
  assert.equal(result.retainedReferencedCount, 1);
  assert.equal(result.deletedFileCount, 0);
  assert.deepEqual(loaded.deletedFiles, []);
  assert.equal(mutated, true);
});

await test("purge performs a guarded second reference scan immediately before storage deletion", async () => {
  const uid = "web-admin-1";
  const lateReference = "cloud://env/wine-packaging/admin-web/old/batch/late-ref.jpg";
  let inserted = false;
  let caseScanCount = 0;
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    webWriteEnabled: "true",
    permanentDeleteEnabled: "true",
    cases: [{
      _id: "trash-late-ref",
      title: "二次核验",
      caseId: "case_701",
      coverImage: lateReference,
      galleryImages: [lateReference],
      deletedAt: "2026-08-01",
      version: 5,
    }],
    queryGetHook({ collectionName, condition, records }) {
      if (collectionName !== "wine_packaging" || condition._id) return;
      caseScanCount += 1;
      if (caseScanCount === 1) {
        inserted = true;
        records.push({
          _id: "late-reference",
          title: "后出现的引用",
          coverImage: lateReference,
          galleryImages: [lateReference],
          version: 1,
        });
      }
    },
  });
  const result = await loaded.main({
    action: "permanentlyDeleteCases",
    ids: ["trash-late-ref"],
    expectedVersions: { "trash-late-ref": 5 },
    clientMutationId: "purge-late-ref",
  });
  assert.equal(result.ok, true);
  assert.equal(inserted, true);
  assert.equal(caseScanCount >= 2, true);
  assert.equal(result.retainedReferencedCount, 1);
  assert.deepEqual(loaded.deletedFiles, []);
});

await test("purge fences every storage batch when lease ownership is lost", async () => {
  const uid = "web-admin-1";
  const jobId = `purge_${"f".repeat(40)}`;
  const fileID = "cloud://env/wine-packaging/admin-web/old/batch/fenced.jpg";
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    purgeJobs: [{
      _id: jobId,
      actor: { type: "cloudbase_uid", id: uid },
      deletedCaseCount: 1,
      candidateFileIds: [fileID],
      pendingFileIds: [fileID],
      deletedFileIds: [],
      retainedReferencedFileIds: [],
      status: "cleanup_pending",
    }],
    transactionHook({ transactionCount, collections }) {
      if (transactionCount !== 2) return;
      const guard = collections.case_admin_purge_jobs.find(
        (item) => item._id === "purge_guard_current"
      );
      guard.activeRunToken = "new-owner-token";
      guard.leaseExpiresAt = "2099-01-01T00:00:00.000Z";
    },
  });
  const result = await loaded.main({ action: "retryPurgeCleanup", jobId });
  assert.equal(result.ok, true);
  assert.equal(result.status, "cleanup_release_pending");
  assert.equal(result.pendingFileCount >= 1, true);
  assert.deepEqual(loaded.deletedFiles, []);
});

await test("purge delete hard timeout keeps its long lease active and returns pending", async () => {
  const uid = "web-admin-1";
  const jobId = `purge_${"7".repeat(40)}`;
  const fileID = "cloud://env/wine-packaging/admin-web/old/batch/timeout.jpg";
  let leaseRemainingMs = 0;
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    immediatePurgeDeleteTimeout: true,
    purgeJobs: [{
      _id: jobId,
      actor: { type: "cloudbase_uid", id: uid },
      deletedCaseCount: 1,
      candidateFileIds: [fileID],
      pendingFileIds: [fileID],
      deletedFileIds: [],
      retainedReferencedFileIds: [],
      status: "cleanup_pending",
    }],
    async deleteFileHook({ collections }) {
      const guard = collections.case_admin_purge_jobs.find(
        (item) => item._id === "purge_guard_current"
      );
      leaseRemainingMs = Date.parse(guard.leaseExpiresAt) - Date.now();
      await new Promise(() => {});
    },
  });
  const result = await loaded.main({ action: "retryPurgeCleanup", jobId });
  assert.equal(result.ok, true);
  assert.equal(result.status, "cleanup_release_pending");
  assert.equal(result.pendingFileCount, 1);
  assert.equal(result.cleanupDeferred, true);
  assert.equal(leaseRemainingMs > 29 * 60 * 1000, true);
  assert.deepEqual(loaded.deletedFiles, []);
  const guard = loaded.collections.case_admin_purge_jobs.find(
    (item) => item._id === "purge_guard_current"
  );
  assert.equal(guard.status, "active");
  assert.equal(typeof guard.activeRunToken, "string");
  assert.equal(guard.activeRunToken.length > 0, true);
});

await test("purge keeps its guard when storage returns an ambiguous response", async () => {
  const uid = "web-admin-1";
  const jobId = `purge_${"4".repeat(40)}`;
  const fileID = "cloud://env/wine-packaging/admin-web/old/batch/ambiguous.jpg";
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    purgeJobs: [{
      _id: jobId,
      actor: { type: "cloudbase_uid", id: uid },
      deletedCaseCount: 1,
      candidateFileIds: [fileID],
      pendingFileIds: [fileID],
      deletedFileIds: [],
      retainedReferencedFileIds: [],
      status: "cleanup_pending",
    }],
    deleteFileResponseHook() {
      return { fileList: [] };
    },
  });
  const result = await loaded.main({ action: "retryPurgeCleanup", jobId });
  assert.equal(result.ok, true);
  assert.equal(result.status, "cleanup_release_pending");
  assert.equal(result.deletedFileCount, 0);
  assert.equal(result.pendingFileCount, 1);
  assert.deepEqual(loaded.deletedFiles, []);
  assert.equal(
    loaded.collections.case_admin_purge_jobs.find(
      (item) => item._id === "purge_guard_current"
    ).status,
    "active"
  );
});

await test("invalid purge lease is fenced and no longer blocks an image update", async () => {
  const oldImage = "cloud://env/wine-packaging/cases/expired-old.jpg";
  const nextImage = "cloud://env/wine-packaging/cases/expired-next.jpg";
  const loaded = loadCaseAdminFunction({
    purgeJobs: [{
      _id: "purge_guard_current",
      status: "active",
      activeJobId: `purge_${"9".repeat(40)}`,
      activeRunToken: "invalid-owner",
      leaseExpiresAt: "not-a-date",
    }],
    cases: [{
      _id: "expired-guard-update",
      title: "过期锁案例",
      caseId: "case_903",
      coverImage: oldImage,
      galleryImages: [oldImage],
      packageTypes: { values: ["礼盒"] },
      isVisible: false,
      version: 1,
    }],
  });
  const result = await loaded.main({
    action: "updateCase",
    id: "expired-guard-update",
    case: { coverImage: nextImage, galleryImages: [nextImage] },
  });
  assert.equal(result.ok, true);
  const guard = loaded.collections.case_admin_purge_jobs.find(
    (item) => item._id === "purge_guard_current"
  );
  assert.equal(guard.status, "idle");
  assert.equal(guard.activeRunToken, "");
});

await test("a missing purge lease can be atomically taken over for recovery", async () => {
  const uid = "web-admin-1";
  const jobId = `purge_${"6".repeat(40)}`;
  const fileID = "cloud://env/wine-packaging/admin-web/old/batch/missing-lease.jpg";
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    purgeJobs: [{
      _id: "purge_guard_current",
      status: "active",
      activeJobId: `purge_${"5".repeat(40)}`,
      activeRunToken: "legacy-owner",
    }, {
      _id: jobId,
      actor: { type: "cloudbase_uid", id: uid },
      deletedCaseCount: 1,
      candidateFileIds: [fileID],
      pendingFileIds: [fileID],
      deletedFileIds: [],
      retainedReferencedFileIds: [],
      status: "cleanup_pending",
    }],
  });
  const result = await loaded.main({ action: "retryPurgeCleanup", jobId });
  assert.equal(result.ok, true);
  assert.equal(result.pendingFileCount, 0);
  assert.deepEqual(loaded.deletedFiles, [fileID]);
  const guard = loaded.collections.case_admin_purge_jobs.find(
    (item) => item._id === "purge_guard_current"
  );
  assert.equal(guard.status, "idle");
});

await test("a stale guard without a lease does not block a new permanent delete", async () => {
  const uid = "web-admin-1";
  const fileID = "cloud://env/wine-packaging/cases/stale-new-purge.jpg";
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    webWriteEnabled: "true",
    permanentDeleteEnabled: "true",
    purgeJobs: [{
      _id: "purge_guard_current",
      status: "active",
      activeJobId: `purge_${"3".repeat(40)}`,
      activeRunToken: "legacy-no-lease",
    }],
    cases: [{
      _id: "trash-stale-guard",
      title: "旧锁永久删除",
      caseId: "case_905",
      coverImage: fileID,
      deletedAt: "2026-08-01",
      version: 2,
    }],
  });
  const result = await loaded.main({
    action: "permanentlyDeleteCases",
    ids: ["trash-stale-guard"],
    expectedVersions: { "trash-stale-guard": 2 },
    clientMutationId: "stale-guard-new-purge",
  });
  assert.equal(result.ok, true);
  assert.equal(result.pendingFileCount, 0);
  assert.deepEqual(loaded.deletedFiles, [fileID]);
});

await test("active purge guard blocks new image references but permits metadata-only edits", async () => {
  const uid = "web-admin-1";
  const existingSource =
    `cloud://env/wine-packaging/admin-web/${uid}/existing/source.jpg`;
  const existingVariants = buildVariantSet(existingSource);
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    webWriteEnabled: "true",
    permanentDeleteEnabled: "true",
    purgeJobs: [{
      _id: "purge_guard_current",
      status: "active",
      activeJobId: `purge_${"a".repeat(40)}`,
      activeRunToken: "active-owner",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    }],
    cases: [{
      _id: "editable",
      title: "原标题",
      caseId: "case_702",
      packageTypes: { values: ["礼盒"] },
      ...existingVariants,
      isVisible: false,
      version: 3,
    }],
  });
  const createSource =
    `cloud://env/wine-packaging/admin-web/${uid}/new-batch/source.jpg`;
  const blockedCreate = await loaded.main({
    action: "createCase",
    clientMutationId: "blocked-create",
    uploadBatchId: "new-batch",
    case: {
      title: "不应新增引用",
      packageTypes: [],
      ...buildVariantSet(createSource),
      isVisible: false,
    },
  });
  assert.equal(blockedCreate.code, "PURGE_CLEANUP_IN_PROGRESS");

  const metadataUpdate = await loaded.main({
    action: "updateCase",
    id: "editable",
    expectedVersion: 3,
    case: { title: "仅改标题" },
  });
  assert.equal(metadataUpdate.ok, true);
  assert.equal(loaded.collections.wine_packaging[0].title, "仅改标题");
});

await test("a cleanup retry fails closed when another purge owns the global guard", async () => {
  const uid = "web-admin-1";
  const targetJobId = `purge_${"b".repeat(40)}`;
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    webWriteEnabled: "true",
    permanentDeleteEnabled: "true",
    purgeJobs: [{
      _id: "purge_guard_current",
      status: "active",
      activeJobId: `purge_${"a".repeat(40)}`,
      activeRunToken: "other-active-owner",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    }, {
      _id: targetJobId,
      actor: { type: "cloudbase_uid", id: uid },
      deletedCaseCount: 1,
      candidateFileIds: ["cloud://env/wine-packaging/admin-web/old/batch/pending.jpg"],
      pendingFileIds: ["cloud://env/wine-packaging/admin-web/old/batch/pending.jpg"],
      deletedFileIds: [],
      retainedReferencedFileIds: [],
      status: "cleanup_pending",
    }],
  });
  const result = await loaded.main({
    action: "retryPurgeCleanup",
    jobId: targetJobId,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "PURGE_CLEANUP_BUSY");
  assert.deepEqual(loaded.deletedFiles, []);
  assert.equal(
    loaded.collections.case_admin_purge_jobs.find(
      (item) => item._id === "purge_guard_current"
    ).activeJobId,
    `purge_${"a".repeat(40)}`
  );
});

await test("new feature actions honor web-only access, write gate and their independent switches", async () => {
  const uid = "web-admin-1";
  const disabled = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    webWriteEnabled: "true",
  });
  assert.equal((await disabled.main({ action: "listAdminActivity" })).code, "ACTIVITY_SYNC_DISABLED");
  assert.equal((await disabled.main({
    action: "permanentlyDeleteCases",
    ids: ["x"],
    clientMutationId: "disabled",
  })).code, "PERMANENT_DELETE_DISABLED");
  assert.equal((await disabled.main({
    action: "listPendingPurgeJobs",
  })).ok, true);

  const readOnly = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    activitySyncEnabled: "true",
    permanentDeleteEnabled: "true",
  });
  assert.equal((await readOnly.main({
    action: "registerUploadItems",
    items: [],
  })).code, "WEB_WRITE_DISABLED");
  assert.equal((await readOnly.main({
    action: "retryPurgeCleanup",
    jobId: `purge_${"a".repeat(40)}`,
  })).code, "PURGE_JOB_NOT_FOUND");

  const mini = loadCaseAdminFunction({
    openid: "admin_openid",
    permanentDeleteEnabled: "true",
  });
  assert.equal((await mini.main({
    action: "permanentlyDeleteCases",
    ids: ["x"],
    clientMutationId: "mini-purge",
  })).code, "WEB_ADMIN_REQUIRED");
  assert.equal((await mini.main({
    action: "listPendingPurgeJobs",
  })).code, "WEB_ADMIN_REQUIRED");
});

await test("committed purge recovery remains available while new purge is disabled", async () => {
  const uid = "web-admin-1";
  const jobId = `purge_${"8".repeat(40)}`;
  const fileID = "cloud://env/wine-packaging/admin-web/old/batch/recover-disabled.jpg";
  const loaded = loadCaseAdminFunction({
    wxContext: {},
    userInfo: { uid, openId: "", isAnonymous: false },
    adminUids: uid,
    purgeJobs: [{
      _id: jobId,
      clientMutationId: "recover-disabled",
      actor: { type: "cloudbase_uid", id: uid },
      deletedCaseCount: 1,
      candidateFileIds: [fileID],
      pendingFileIds: [fileID],
      deletedFileIds: [],
      retainedReferencedFileIds: [],
      status: "cleanup_pending",
    }],
  });
  const pending = await loaded.main({ action: "listPendingPurgeJobs" });
  assert.equal(pending.ok, true);
  assert.equal(pending.items.length, 1);
  const retried = await loaded.main({ action: "retryPurgeCleanup", jobId });
  assert.equal(retried.ok, true);
  assert.equal(retried.pendingFileCount, 0);
  assert.deepEqual(loaded.deletedFiles, [fileID]);
  assert.equal((await loaded.main({
    action: "permanentlyDeleteCases",
    ids: ["new-purge-still-disabled"],
    clientMutationId: "new-purge-still-disabled",
  })).code, "WEB_WRITE_DISABLED");
});
