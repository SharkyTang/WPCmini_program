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
  "../miniprogram/cloudfunctions/userLibrary/index.js"
);
const logic = require(resolve(
  __dirname,
  "../miniprogram/cloudfunctions/userLibrary/userLibraryLogic.js"
));

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function matches(record, condition = {}) {
  return Object.entries(condition).every(([key, expected]) => record[key] === expected);
}

function loadUserLibrary(options = {}) {
  const recordsByCollection = Object.fromEntries(
    Object.entries(options.recordsByCollection || {}).map(([name, records]) => [
      name,
      records.map((record) => ({ ...record })),
    ])
  );
  const calls = { transactions: 0, sets: [], updates: [], removes: [] };
  let dateSequence = 0;

  function collection(name) {
    if (!recordsByCollection[name]) recordsByCollection[name] = [];
    const state = {
      where: null,
      orderField: "",
      orderDirection: "asc",
      limit: Infinity,
    };
    return {
      where(condition) {
        state.where = condition;
        return this;
      },
      orderBy(field, direction) {
        state.orderField = field;
        state.orderDirection = direction;
        return this;
      },
      limit(value) {
        state.limit = value;
        return this;
      },
      async get() {
        let items = recordsByCollection[name].filter((record) =>
          state.where ? matches(record, state.where) : true
        );
        if (state.orderField) {
          items = items.slice().sort((a, b) => {
            const comparison = String(a[state.orderField] || "").localeCompare(
              String(b[state.orderField] || "")
            );
            return state.orderDirection === "desc" ? -comparison : comparison;
          });
        }
        return { data: items.slice(0, state.limit).map((item) => ({ ...item })) };
      },
      async remove() {
        const removed = recordsByCollection[name].filter((record) =>
          state.where ? matches(record, state.where) : true
        );
        removed.forEach((record) => {
          calls.removes.push({ name, id: record._id });
        });
        recordsByCollection[name] = recordsByCollection[name].filter((record) =>
          state.where ? !matches(record, state.where) : false
        );
        return { deleted: removed.length };
      },
      doc(id) {
        return {
          async set(payload) {
            calls.sets.push({ name, id, payload: plain(payload) });
            const next = { _id: id, ...(payload.data || {}) };
            const index = recordsByCollection[name].findIndex((record) => record._id === id);
            if (index >= 0) recordsByCollection[name][index] = next;
            else recordsByCollection[name].push(next);
            return {};
          },
          async update(payload) {
            calls.updates.push({ name, id, payload: plain(payload) });
            const record = recordsByCollection[name].find((item) => item._id === id);
            if (!record) throw new Error("missing record");
            Object.entries(payload.data || {}).forEach(([key, value]) => {
              if (value && typeof value === "object" && "$inc" in value) {
                record[key] = (Number(record[key]) || 0) + value.$inc;
              } else {
                record[key] = value;
              }
            });
            return {};
          },
          async remove() {
            calls.removes.push({ name, id });
            recordsByCollection[name] = recordsByCollection[name].filter(
              (record) => record._id !== id
            );
            return {};
          },
        };
      },
    };
  }

  const database = {
    command: {
      inc(value) {
        return { $inc: value };
      },
    },
    serverDate() {
      dateSequence += 1;
      return `server-date-${String(dateSequence).padStart(3, "0")}`;
    },
    collection,
    async runTransaction(callback) {
      calls.transactions += 1;
      return callback({
        collection(name) {
          const reference = collection(name);
          return {
            doc: reference.doc,
          };
        },
      });
    },
  };

  const mockCloud = {
    DYNAMIC_CURRENT_ENV: "dynamic-env",
    init() {},
    getWXContext() {
      return { OPENID: options.openid || "openid_server" };
    },
    database() {
      return database;
    },
  };
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console,
    require(moduleName) {
      if (moduleName === "wx-server-sdk") return mockCloud;
      if (moduleName === "./userLibraryLogic") return logic;
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
    recordsByCollection,
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

await test("library document ids are stable per user and case", async () => {
  const reference = { caseDocId: "doc_1", caseId: "case_1" };
  const first = logic.buildLibraryDocumentId("favorites", "openid_a", reference);
  const second = logic.buildLibraryDocumentId("favorites", "openid_a", reference);
  const otherUser = logic.buildLibraryDocumentId("favorites", "openid_b", reference);
  assert.equal(first, second);
  assert.notEqual(first, otherUser);
  assert.equal(first.length, 32);
  assert.equal(logic.normalizeCaseReference({ caseDocId: "" }), null);
});

await test("favorite writes use server identity and remain sequentially idempotent", async () => {
  const runtime = loadUserLibrary({ openid: "openid_server" });
  const event = {
    action: "addFavorite",
    openid: "spoofed",
    favorite: { caseDocId: "doc_1", caseId: "case_1" },
  };

  const first = await runtime.main(event);
  const second = await runtime.main(event);

  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(runtime.recordsByCollection.favorites.length, 1);
  assert.equal(runtime.recordsByCollection.favorites[0]._openid, "openid_server");
  assert.equal(runtime.recordsByCollection.favorites[0].openid, "openid_server");
  assert.equal(runtime.calls.transactions, 1);
});

await test("favorite limit is enforced before the write transaction", async () => {
  const favorites = Array.from({ length: 100 }, (_, index) => ({
    _id: `fav_${index}`,
    _openid: "openid_server",
    caseDocId: `doc_${index}`,
    caseId: `case_${index}`,
  }));
  const runtime = loadUserLibrary({
    recordsByCollection: { favorites },
  });

  const result = await runtime.main({
    action: "addFavorite",
    favorite: { caseDocId: "doc_new", caseId: "case_new" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.limitReached, true);
  assert.equal(runtime.recordsByCollection.favorites.length, 100);
  assert.equal(runtime.calls.sets.length, 0);
});

await test("history upserts increment one record and preserve the 50 item limit", async () => {
  const history = Array.from({ length: 50 }, (_, index) => ({
    _id: `his_${index}`,
    _openid: "openid_server",
    caseDocId: `doc_${index}`,
    caseId: `case_${index}`,
    viewCount: 1,
    lastViewedAt: `server-date-${String(index).padStart(3, "0")}`,
  }));
  const runtime = loadUserLibrary({
    recordsByCollection: { browse_history: history },
  });

  const created = await runtime.main({
    action: "recordHistory",
    history: { caseDocId: "doc_new", caseId: "case_new" },
  });
  const updated = await runtime.main({
    action: "recordHistory",
    history: { caseDocId: "doc_new", caseId: "case_new" },
  });

  assert.equal(created.ok, true);
  assert.equal(updated.history.viewCount, 2);
  assert.equal(runtime.recordsByCollection.browse_history.length, 50);
  assert.equal(
    runtime.recordsByCollection.browse_history.filter(
      (record) => record.caseDocId === "doc_new"
    ).length,
    1
  );
  assert.equal(runtime.calls.updates.length, 1);
});

await test("record removal cannot delete another user's data", async () => {
  const runtime = loadUserLibrary({
    recordsByCollection: {
      favorites: [
        { _id: "mine", _openid: "openid_server", caseDocId: "doc_1" },
        { _id: "theirs", _openid: "openid_other", caseDocId: "doc_2" },
      ],
    },
  });

  const result = await runtime.main({
    action: "removeFavorites",
    ids: ["mine", "theirs"],
  });

  assert.equal(result.removedCount, 1);
  assert.deepEqual(
    runtime.recordsByCollection.favorites.map((record) => record._id),
    ["theirs"]
  );
  assert.equal(runtime.calls.transactions, 0);
});

await test("clear removes every owned record and leaves other users untouched", async () => {
  const runtime = loadUserLibrary({
    recordsByCollection: {
      browse_history: [
        { _id: "mine_1", _openid: "openid_server", caseDocId: "doc_1" },
        { _id: "mine_2", _openid: "openid_server", caseDocId: "doc_2" },
        { _id: "theirs", _openid: "openid_other", caseDocId: "doc_3" },
      ],
    },
  });

  const result = await runtime.main({ action: "clearHistory" });

  assert.equal(result.removedCount, 2);
  assert.deepEqual(
    runtime.recordsByCollection.browse_history.map((record) => record._id),
    ["theirs"]
  );
});
