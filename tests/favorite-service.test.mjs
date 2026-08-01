import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { loadOpenIdLibraryAccessService } from "./library-openid-test-helper.mjs";

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
      if (path === "./caseCatalogService") {
        return {
          fetchUserLibrary:
            options.fetchUserLibrary ||
            (async () => {
              throw new Error("catalog unavailable");
            }),
        };
      }
      if (path === "./userLibraryService") {
        if (options.userLibraryService) return options.userLibraryService;
        return {
          async callUserLibrary() {
            const error = new Error("function not found");
            error.code = "FUNCTION_NOT_FOUND";
            throw error;
          },
          isUserLibraryUnavailableError(error) {
            return error && error.code === "FUNCTION_NOT_FOUND";
          },
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
                    async count() {
                      return { total: options.favoriteCount || 0 };
                    },
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

await test("openid build flag supports favorite query, add, and delete without a profile", async () => {
  const access = loadOpenIdLibraryAccessService("favorites");
  const { service, removedIds } = loadFavoriteService({
    [JSON.stringify({ _openid: "openid_1", caseDocId: "doc_001" })]: [
      { _id: "fav_1", caseDocId: "doc_001", caseId: "case_001" },
    ],
  }, {
    libraryAccessService: access.service,
  });

  const favorite = await service.fetchFavoriteForCase({
    id: "doc_001",
    caseId: "case_001",
  });
  const added = await service.addFavorite({
    id: "doc_002",
    caseId: "case_002",
  });
  const removed = await service.removeFavorite("fav_1");

  assert.equal(favorite._id, "fav_1");
  assert.equal(added._id, "fav_new");
  assert.equal(removed, true);
  assert.deepEqual(plain(removedIds), ["fav_1"]);
  assert.equal(access.profileChecks, 0);
  assert.equal(access.openidChecks > 0, true);
});

await test("favorite mutations prefer the atomic cloud service when available", async () => {
  const calls = [];
  const { service, whereCalls } = loadFavoriteService({}, {
    userLibraryService: {
      async callUserLibrary(action, payload = {}) {
        calls.push({ action, payload });
        if (action === "addFavorite") {
          return {
            favorite: {
              _id: "fav_atomic",
              caseDocId: payload.favorite.caseDocId,
              caseId: payload.favorite.caseId,
            },
          };
        }
        return { removedCount: 1 };
      },
      isUserLibraryUnavailableError() {
        return false;
      },
    },
  });

  const added = await service.addFavorite({ id: "doc_atomic", caseId: "case_atomic" });
  const removed = await service.removeFavorite("fav_atomic");

  assert.equal(added._id, "fav_atomic");
  assert.equal(removed, true);
  assert.deepEqual(plain(calls), [
    {
      action: "addFavorite",
      payload: { favorite: { caseDocId: "doc_atomic", caseId: "case_atomic" } },
    },
    {
      action: "removeFavorites",
      payload: { ids: ["fav_atomic"] },
    },
  ]);
  assert.equal(whereCalls.length, 0);
});
