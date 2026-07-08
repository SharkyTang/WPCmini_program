import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const caseRefreshPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/utils/caseRefresh.js"
);

function loadCaseRefresh(globalData) {
  const sandbox = {
    module: { exports: {} },
    exports: {},
    getApp: globalData
      ? () => ({
          globalData,
        })
      : undefined,
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(readFileSync(caseRefreshPath, "utf8"), sandbox, {
    filename: caseRefreshPath,
  });
  return sandbox.module.exports;
}

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("case data version defaults to zero without app context", () => {
  const { getCaseDataVersion, shouldRefreshCaseData } = loadCaseRefresh(null);

  assert.equal(getCaseDataVersion(), 0);
  assert.equal(shouldRefreshCaseData(0), false);
});

test("markCaseDataStale increments the shared app version", () => {
  const globalData = { caseDataVersion: 2 };
  const { getCaseDataVersion, markCaseDataStale } = loadCaseRefresh(globalData);

  assert.equal(markCaseDataStale(), 3);
  assert.equal(getCaseDataVersion(), 3);
  assert.equal(globalData.caseDataVersion, 3);
});

test("shouldRefreshCaseData detects stale page data", () => {
  const globalData = { caseDataVersion: 4 };
  const { shouldRefreshCaseData } = loadCaseRefresh(globalData);

  assert.equal(shouldRefreshCaseData(3), true);
  assert.equal(shouldRefreshCaseData(4), false);
});
