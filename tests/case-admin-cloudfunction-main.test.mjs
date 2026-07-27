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
      return expected.values.includes(record[field]);
    }
    return record[field] === expected;
  });
}

function createQuery(collectionName, records, calls, condition = {}) {
  const query = {
    limitValue: null,
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
      calls.push({ collectionName, type: "skip", value });
      return this;
    },
    async get() {
      let data = records.filter((record) => matchesCondition(record, condition));
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
        },
        serverDate() {
          return "server-date";
        },
        collection(collectionName) {
          const records = collections[collectionName] || [];
          return {
            ...createQuery(collectionName, records, calls),
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

await test("deleteCase removes an unreferenced case image", async () => {
  const { main, collections, deletedFiles } = loadCaseAdminFunction({
    cases: [{ _id: "case_doc_1", coverImage: "cloud://env/case.jpg" }],
  });

  const result = await main({ action: "deleteCase", id: "case_doc_1" });

  assert.equal(result.ok, true);
  assert.equal(result.id, "case_doc_1");
  assert.deepEqual(clone(result.deletedFileIds), ["cloud://env/case.jpg"]);
  assert.deepEqual(deletedFiles, ["cloud://env/case.jpg"]);
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
