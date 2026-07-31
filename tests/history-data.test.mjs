import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(
  __dirname,
  "../miniprogram/miniprogram/utils/historyData.js"
);
const source = readFileSync(modulePath, "utf8");
const sandbox = {
  module: { exports: {} },
  exports: {},
  console,
};
sandbox.exports = sandbox.module.exports;
vm.runInNewContext(source, sandbox, { filename: modulePath });

const {
  buildHistoryRecord,
  getOverflowHistoryIds,
  getHistoryCaseLookupKeys,
  mergeHistoryWithCases,
  normalizeSelectedIds,
} = sandbox.module.exports;

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("builds a compact history record from a case", () => {
  const record = buildHistoryRecord({
    id: "doc_001",
    caseId: "case_001",
  });

  assert.deepEqual(plain(record), {
    caseDocId: "doc_001",
    caseId: "case_001",
  });
});

test("uses the document id as caseId fallback when a case has no stable caseId", () => {
  const record = buildHistoryRecord({
    id: "doc_only",
  });

  assert.deepEqual(plain(record), {
    caseDocId: "doc_only",
    caseId: "doc_only",
  });
});

test("returns unique lookup keys for history records", () => {
  const keys = getHistoryCaseLookupKeys([
    { caseDocId: "doc_001", caseId: "case_001" },
    { caseDocId: "doc_001", caseId: "case_001" },
    { caseDocId: "", caseId: "case_002" },
  ]);

  assert.deepEqual(plain(keys), ["doc_001", "case_001", "case_002"]);
});

test("merges history records with visible cases and drops invalid records", () => {
  const records = [
    { _id: "history_1", caseDocId: "doc_001", caseId: "case_001", viewCount: 3 },
    { _id: "history_2", caseDocId: "missing", caseId: "missing_case" },
    { _id: "history_3", caseDocId: "doc_hidden", caseId: "case_hidden" },
  ];
  const cases = [
    { id: "doc_001", caseId: "case_001", title: "可见案例", isVisible: true },
    { id: "doc_hidden", caseId: "case_hidden", title: "隐藏案例", isVisible: false },
  ];

  const merged = mergeHistoryWithCases(records, cases);

  assert.deepEqual(plain(merged), [
    {
      historyId: "history_1",
      viewCount: 3,
      caseItem: { id: "doc_001", caseId: "case_001", title: "可见案例", isVisible: true },
    },
  ]);
});

test("normalizes selected history ids by removing duplicates and empty values", () => {
  const ids = normalizeSelectedIds(["history_1", "", null, "history_2", "history_1"]);

  assert.deepEqual(plain(ids), ["history_1", "history_2"]);
});

test("returns overflow history ids after the newest records are kept", () => {
  const records = Array.from({ length: 5 }, (_, index) => ({
    _id: `history_${index + 1}`,
  }));

  const overflowIds = getOverflowHistoryIds(records, 3);

  assert.deepEqual(plain(overflowIds), ["history_4", "history_5"]);
});

test("keeps the 50 item history limit unchanged", () => {
  const records = Array.from({ length: 51 }, (_, index) => ({
    _id: `history_${index + 1}`,
  }));

  assert.deepEqual(plain(getOverflowHistoryIds(records.slice(0, 49), 50)), []);
  assert.deepEqual(plain(getOverflowHistoryIds(records.slice(0, 50), 50)), []);
  assert.deepEqual(plain(getOverflowHistoryIds(records, 50)), ["history_51"]);
});
