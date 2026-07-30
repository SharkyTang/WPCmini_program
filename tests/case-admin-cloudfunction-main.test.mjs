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
    return record[field] === expected;
  });
}

function createQuery(
  collectionName,
  records,
  calls,
  condition = {},
  queryGetError = null
) {
  const query = {
    limitValue: null,
    skipValue: 0,
    where(nextCondition) {
      calls.push({ collectionName, type: "where", condition: nextCondition });
      return createQuery(
        collectionName,
        records,
        calls,
        nextCondition,
        queryGetError
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
      data = data.slice(this.skipValue);
      if (this.limitValue !== null) data = data.slice(0, this.limitValue);
      return { data: clone(data) };
    },
  };
  return query;
}

function loadCaseAdminFunction(options = {}) {
  const calls = [];
  const deletedFiles = [];
  const tempFileRequests = [];
  let transactionCount = 0;
  const collections = {
    wine_packaging: clone(options.cases || []),
    home_banners: clone(options.banners || []),
    catalog_meta: clone(options.catalogMeta || []),
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
      deletedFiles.push(...fileList);
      return { fileList };
    },
    async getTempFileURL({ fileList }) {
      tempFileRequests.push(...fileList);
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
        },
        serverDate() {
          return "server-date";
        },
        collection(collectionName) {
          const records = collections[collectionName] || [];
          return {
            ...createQuery(
              collectionName,
              records,
              calls,
              {},
              options.queryGetError
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
                  const record = records.find((item) => item._id === id);
                  if (!record) throw new Error("document not found");
                  return { data: clone(record) };
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
          if (transactionCount === options.transactionFailureAt) {
            throw new Error(options.transactionFailureMessage || "transaction connection lost");
          }
          return callback(databaseApi);
        };
      }
      return databaseApi;
    },
  };

  const sandbox = {
    module: { exports: {} },
    exports: {},
    console: {
      ...console,
      error() {},
      warn() {},
    },
    process: {
      env: {
        ADMIN_OPENIDS: options.adminOpenids || "admin_openid",
        CASE_ADMIN_UIDS: options.adminUids || "",
        ADMIN_WEB_WRITE_ENABLED: options.webWriteEnabled || "",
      },
    },
    require(moduleName) {
      if (moduleName === "node:crypto") return require("node:crypto");
      if (moduleName === "wx-server-sdk") return mockCloud;
      if (moduleName === "./caseAdminLogic") return logic;
      if (moduleName === "@cloudbase/node-sdk" && options.userInfo) {
        return {
          SYMBOL_CURRENT_ENV: "current-env",
          init() {
            return {
              auth() {
                return {
                  getUserInfo() {
                    if (options.userInfoError) throw options.userInfoError;
                    return clone(options.userInfo);
                  },
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
    collections,
    deletedFiles,
    tempFileRequests,
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
  assert.deepEqual(deletedFiles, [unused]);
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
  const { main, collections, deletedFiles } = loadCaseAdminFunction({
    cases: [{
      _id: "case_doc_1",
      coverImage: "cloud://env/case.jpg",
      isVisible: true,
      isPinned: true,
      homeSections: { values: ["banner"] },
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
