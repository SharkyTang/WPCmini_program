import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(
  __dirname,
  "../miniprogram/miniprogram/utils/favoriteService.js"
);

function loadFavoriteService(recordsByCondition = {}, options = {}) {
  const whereCalls = [];
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
      if (path === "./favoriteData") {
        return {
          buildFavoriteRecord(caseItem) {
            return {
              caseDocId: caseItem.id,
              caseId: caseItem.caseId || caseItem.id,
            };
          },
          isFavoriteLimitReached: () => false,
          mergeFavoritesWithCases: options.mergeFavoritesWithCases || ((favorites, cases) => cases),
          normalizeSelectedFavoriteIds: (ids) => ids.filter(Boolean),
        };
      }
      if (path === "./userService") {
        return {
          ensureProfileIdentity: async () => ({ ready: true, openid: "openid_1" }),
          getCachedOpenId: () => "openid_1",
        };
      }
      throw new Error(`Unexpected require: ${path}`);
    },
    wx: {
      cloud: {
        database() {
          return {
            command: {
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
                count: async () => ({ total: 0 }),
                add: async () => ({ _id: "fav_new" }),
                doc(id) {
                  return {
                    remove: async () => {
                      removedIds.push(id);
                      return {};
                    },
                  };
                },
                orderBy() {
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

await test("fetchFavoriteForCase uses simple indexed lookups instead of an OR query", async () => {
  const { service, whereCalls } = loadFavoriteService({
    [JSON.stringify({ _openid: "openid_1", caseId: "case_001" })]: [{ _id: "fav_1" }],
  });

  const favorite = await service.fetchFavoriteForCase({
    id: "doc_001",
    caseId: "case_001",
  });

  assert.deepEqual(plain(whereCalls), [
    { _openid: "openid_1", caseDocId: "doc_001" },
    { _openid: "openid_1", caseId: "case_001" },
  ]);
  assert.deepEqual(plain(favorite), { _id: "fav_1" });
});

await test("fetchFavoriteCases removes records whose cases no longer exist", async () => {
  const staleError = new Error("案例不存在：doc_missing");
  staleError.code = "CASE_NOT_FOUND";
  const { service, removedIds } = loadFavoriteService({}, {
    listRecords: [
      { _id: "fav_missing", caseDocId: "doc_missing", caseId: "case_999" },
      { _id: "fav_live", caseDocId: "doc_live", caseId: "case_001" },
    ],
    fetchCaseById: async (id) => {
      if (id === "doc_missing") throw staleError;
      return { _id: "doc_live", caseId: "case_001" };
    },
  });

  const cases = await service.fetchFavoriteCases();

  assert.deepEqual(plain(removedIds), ["fav_missing"]);
  assert.deepEqual(plain(cases), [{ _id: "doc_live", caseId: "case_001" }]);
});
