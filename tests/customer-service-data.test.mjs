import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(
  __dirname,
  "../miniprogram/miniprogram/utils/customerServiceData.js"
);
const module = { exports: {} };
vm.runInNewContext(
  readFileSync(modulePath, "utf8"),
  { module, exports: module.exports },
  { filename: modulePath }
);
const {
  CUSTOMER_SERVICE_SOURCE,
  buildCustomerSessionFrom,
} = module.exports;

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("builds profile customer service session source", () => {
  assert.equal(
    buildCustomerSessionFrom({ source: CUSTOMER_SERVICE_SOURCE.PROFILE }),
    "source=profile"
  );
});

test("builds detail customer service session source with case context", () => {
  const sessionFrom = buildCustomerSessionFrom({
    source: CUSTOMER_SERVICE_SOURCE.DETAIL,
    caseItem: {
      _id: "doc_001",
      caseId: "case_001",
      title: "整套包装方案",
    },
  });

  assert.equal(
    sessionFrom,
    "source=detail&caseDocId=doc_001&caseId=case_001&title=%E6%95%B4%E5%A5%97%E5%8C%85%E8%A3%85%E6%96%B9%E6%A1%88"
  );
});

test("keeps detail customer service session source compact", () => {
  const sessionFrom = buildCustomerSessionFrom({
    source: CUSTOMER_SERVICE_SOURCE.DETAIL,
    caseItem: {
      _id: "doc_001",
      caseId: "case_001",
      title: "很长".repeat(120),
    },
  });

  assert.ok(sessionFrom.length <= 240);
  assert.ok(sessionFrom.startsWith("source=detail&caseDocId=doc_001&caseId=case_001&title="));
});
