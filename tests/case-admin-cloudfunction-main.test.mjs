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

function createQuery(collectionName, records, calls, condition = {}) {
  const query = {
    limitValue: null,
    skipValue: 0,
    where(nextCondition) {
      calls.push({ collectionName, type: "where", condition: nextCondition });
      return createQuery(collectionName, records, calls, nextCondition);
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
  const collections = {
    wine_packaging: clone(options.cases || []),
    home_banners: clone(options.banners || []),
  };

  const mockCloud = {
    DYNAMIC_CURRENT_ENV: "dynamic-env",
    init() {},
    getWXContext() {
      return {
        OPENID: options.openid || "admin_openid",
      };
    },
    async deleteFile({ fileList }) {
      deletedFiles.push(...fileList);
      return { fileList };
    },
    database() {
      return {
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
            ...createQuery(collectionName, records, calls),
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
                  calls.push({ collectionName, type: "update", id, payload });
                  return {};
                },
              };
            },
          };
        },
      };
    },
  };

  const sandbox = {
    module: { exports: {} },
    exports: {},
    console,
    process: {
      env: {
        ADMIN_OPENIDS: options.adminOpenids || "admin_openid",
      },
    },
    require(moduleName) {
      if (moduleName === "wx-server-sdk") return mockCloud;
      if (moduleName === "./caseAdminLogic") return logic;
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

await test("deleteCase reports missing cases", async () => {
  const { main } = loadCaseAdminFunction();

  const result = await main({ action: "deleteCase", id: "missing_case" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "CASE_NOT_FOUND");
});

await test("deleteCase preserves an unreferenced legacy source image", async () => {
  const { main, collections, deletedFiles } = loadCaseAdminFunction({
    cases: [{ _id: "case_doc_1", coverImage: "cloud://env/case.jpg" }],
  });

  const result = await main({ action: "deleteCase", id: "case_doc_1" });

  assert.equal(result.ok, true);
  assert.equal(result.id, "case_doc_1");
  assert.deepEqual(clone(result.deletedFileIds), []);
  assert.deepEqual(clone(result.preservedSourceFileIds), ["cloud://env/case.jpg"]);
  assert.deepEqual(deletedFiles, []);
  assert.deepEqual(collections.wine_packaging, []);
});

await test("deleteCase keeps images referenced by another case", async () => {
  const { main, collections, deletedFiles } = loadCaseAdminFunction({
    cases: [
      { _id: "case_doc_1", coverImage: "cloud://env/shared.jpg" },
      { _id: "case_doc_2", coverImage: "cloud://env/shared.jpg" },
    ],
  });

  const result = await main({ action: "deleteCase", id: "case_doc_1" });

  assert.equal(result.ok, true);
  assert.deepEqual(clone(result.deletedFileIds), []);
  assert.deepEqual(deletedFiles, []);
  assert.deepEqual(collections.wine_packaging.map((item) => item._id), ["case_doc_2"]);
});

await test("deleteCase keeps images referenced by a visible banner", async () => {
  const { main, deletedFiles } = loadCaseAdminFunction({
    cases: [{ _id: "case_doc_1", coverImage: "cloud://env/banner.jpg" }],
    banners: [{ _id: "banner_1", image: "cloud://env/banner.jpg" }],
  });

  const result = await main({ action: "deleteCase", id: "case_doc_1" });

  assert.equal(result.ok, true);
  assert.deepEqual(clone(result.deletedFileIds), []);
  assert.deepEqual(deletedFiles, []);
});

await test("deleteCase keeps gallery images referenced by another case", async () => {
  const { main, deletedFiles } = loadCaseAdminFunction({
    cases: [
      { _id: "case_doc_1", coverImage: "cloud://env/cover.jpg", galleryImages: ["cloud://env/cover.jpg", "cloud://env/shared-detail.jpg"] },
      { _id: "case_doc_2", coverImage: "cloud://env/other.jpg", galleryImages: ["cloud://env/other.jpg", "cloud://env/shared-detail.jpg"] },
    ],
  });

  const result = await main({ action: "deleteCase", id: "case_doc_1" });

  assert.equal(result.ok, true);
  assert.equal(deletedFiles.includes("cloud://env/shared-detail.jpg"), false);
  assert.equal(deletedFiles.includes("cloud://env/cover.jpg"), false);
});

await test("deleteCase removes unreferenced variants but keeps explicit sources", async () => {
  const { main, deletedFiles } = loadCaseAdminFunction({
    cases: [{
      _id: "case_doc_1",
      sourceGalleryImages: ["cloud://env/source.jpg"],
      galleryImages: ["cloud://env/display.jpg"],
      galleryThumbnails: ["cloud://env/thumb.jpg"],
      coverImage: "cloud://env/display.jpg",
      coverThumbnail: "cloud://env/thumb.jpg",
    }],
  });

  const result = await main({ action: "deleteCase", id: "case_doc_1" });

  assert.equal(result.ok, true);
  assert.deepEqual(clone(result.preservedSourceFileIds), ["cloud://env/source.jpg"]);
  assert.equal(deletedFiles.includes("cloud://env/source.jpg"), false);
  assert.equal(deletedFiles.includes("cloud://env/display.jpg"), true);
  assert.equal(deletedFiles.includes("cloud://env/thumb.jpg"), true);
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
