import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { loadOpenIdLibraryAccessService } from "./library-openid-test-helper.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(
  __dirname,
  "../miniprogram/miniprogram/utils/historyService.js"
);

function loadHistoryService(recordsByCondition = {}, options = {}) {
  const whereCalls = [];
  const updates = [];
  const removedIds = [];
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console,
    require(path) {
      if (path === "./cloudData") {
        return {
          fetchCaseById: options.fetchCaseById || (async () => null),
        };
      }
      if (path === "./historyData") {
        return {
          buildHistoryRecord(caseItem) {
            return {
              caseDocId: caseItem.id,
              caseId: caseItem.caseId || caseItem.id,
            };
          },
          getOverflowHistoryIds: () => [],
          mergeHistoryWithCases: options.mergeHistoryWithCases || ((records, cases) => cases),
          normalizeSelectedIds: (ids) => ids.filter(Boolean),
        };
      }
      if (path === "./caseCatalogService") {
        return {
          fetchUserLibrary:
            options.fetchUserLibrary ||
            (async () => {
              throw new Error("catalog unavailable");
            }),
        };
      }
      if (path === "./userService") {
        return {
          getCachedOpenId: () => "openid_1",
        };
      }
      if (path === "./libraryAccessService") {
        if (options.libraryAccessService) return options.libraryAccessService;
        return {
          checkLibraryAccess:
            options.checkLibraryAccess ||
            (async () => ({ status: "ready", openid: "openid_1" })),
        };
      }
      throw new Error(`Unexpected require: ${path}`);
    },
    wx: {
      cloud: {
        database() {
          return {
            command: {
              inc(value) {
                return { __inc: value };
              },
              or(conditions) {
                return { __or: conditions };
              },
            },
            serverDate() {
              return "server-date";
            },
            collection() {
              return {
                where(condition) {
                  whereCalls.push(condition);
                  return {
                    orderBy() {
                      return this;
                    },
                    skip() {
                      return this;
                    },
                    limit() {
                      return this;
                    },
                    async get() {
                      const key = JSON.stringify(condition);
                      if (Object.prototype.hasOwnProperty.call(recordsByCondition, key)) {
                        return { data: recordsByCondition[key] };
                      }
                      if (condition._id) return { data: [{ _id: condition._id }] };
                      return { data: options.listRecords || [] };
                    },
                  };
                },
                doc(id) {
                  return {
                    async update(payload) {
                      updates.push({ id, payload });
                      return {};
                    },
                    remove: async () => {
                      removedIds.push(id);
                      return {};
                    },
                  };
                },
                add: async () => ({ _id: "history_new" }),
                orderBy() {
                  return this;
                },
                skip() {
                  return this;
                },
                limit() {
                  return this;
                },
                async get() {
                  return { data: options.listRecords || [] };
                },
              };
            },
          };
        },
      },
    },
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(readFileSync(modulePath, "utf8"), sandbox, {
    filename: modulePath,
  });
  return {
    service: sandbox.module.exports,
    updates,
    whereCalls,
    removedIds,
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

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

await test("recordCaseView uses simple indexed lookups before updating history", async () => {
  const { service, updates, whereCalls } = loadHistoryService({
    [JSON.stringify({ _openid: "openid_1", caseId: "case_001" })]: [
      { _id: "history_1", viewCount: 2 },
    ],
  });

  const history = await service.recordCaseView({
    id: "doc_001",
    caseId: "case_001",
  });

  assert.deepEqual(plain(whereCalls.slice(0, 2)), [
    { _openid: "openid_1", caseDocId: "doc_001" },
    { _openid: "openid_1", caseId: "case_001" },
  ]);
  assert.equal(updates.length, 1);
  assert.equal(history._id, "history_1");
  assert.equal(history.viewCount, 3);
});

await test("fetchHistoryCases removes records whose cases no longer exist", async () => {
  const staleError = new Error("案例不存在：doc_missing");
  staleError.code = "CASE_NOT_FOUND";
  const { service, removedIds } = loadHistoryService({}, {
    listRecords: [
      { _id: "history_missing", caseDocId: "doc_missing", caseId: "case_999" },
      { _id: "history_live", caseDocId: "doc_live", caseId: "case_001" },
    ],
    fetchCaseById: async (id) => {
      if (id === "doc_missing") throw staleError;
      return { _id: "doc_live", caseId: "case_001" };
    },
  });

  const cases = await service.fetchHistoryCases();

  assert.deepEqual(plain(removedIds), ["history_missing"]);
  assert.deepEqual(plain(cases), [{ _id: "doc_live", caseId: "case_001" }]);
});

await test("openid build flag supports history write, read, update, and delete without a profile", async () => {
  const access = loadOpenIdLibraryAccessService("history");
  const { service, removedIds, updates } = loadHistoryService({
    [JSON.stringify({ _openid: "openid_1", caseDocId: "doc_001" })]: [
      { _id: "history_1", caseDocId: "doc_001", caseId: "case_001", viewCount: 2 },
    ],
  }, {
    libraryAccessService: access.service,
    fetchUserLibrary: async () => [{
      recordId: "history_1",
      viewCount: 3,
      caseItem: { id: "doc_001", caseId: "case_001" },
    }],
  });

  const created = await service.recordCaseView({
    id: "doc_002",
    caseId: "case_002",
  });
  const updated = await service.recordCaseView({
    id: "doc_001",
    caseId: "case_001",
  });
  const cases = await service.fetchHistoryCases();
  const removedCount = await service.removeHistoryRecords(["history_1"]);

  assert.equal(created._id, "history_new");
  assert.equal(updated.viewCount, 3);
  assert.equal(updates.length, 1);
  assert.deepEqual(plain(cases), [{
    historyId: "history_1",
    viewCount: 3,
    caseItem: { id: "doc_001", caseId: "case_001" },
  }]);
  assert.equal(removedCount, 1);
  assert.deepEqual(plain(removedIds), ["history_1"]);
  assert.equal(access.profileChecks, 0);
  assert.equal(access.openidChecks > 0, true);
});
