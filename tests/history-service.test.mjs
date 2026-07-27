import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(
  __dirname,
  "../miniprogram/miniprogram/utils/historyService.js"
);

function loadHistoryService(recordsByCondition = {}) {
  const whereCalls = [];
  const updates = [];
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console,
    require(path) {
      if (path === "./cloudData") {
        return {
          fetchCaseById: async () => null,
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
          mergeHistoryWithCases: () => [],
          normalizeSelectedIds: (ids) => ids.filter(Boolean),
        };
      }
      if (path === "./userService") {
        return {
          ensureWxIdentity: async () => "openid_1",
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
                      return { data: recordsByCondition[key] || [] };
                    },
                  };
                },
                doc(id) {
                  return {
                    async update(payload) {
                      updates.push({ id, payload });
                      return {};
                    },
                    remove: async () => ({}),
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
                  return { data: [] };
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
