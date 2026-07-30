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
  DEFAULT_CUSTOMER_MESSAGE_TITLE,
  buildCustomerMessageCard,
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

test("builds a customer message card with a preferred id and encoded detail path", () => {
  const card = buildCustomerMessageCard({
    caseItem: {
      id: "doc 酒 #1",
      _id: "fallback_doc",
      caseId: "fallback_case",
      title: "  国风酒盒  ",
      coverImageUrl: "https://example.com/fallback.jpg",
    },
    imageUrl: "  https://example.com/cover.jpg  ",
  });

  assert.equal(card.enabled, true);
  assert.equal(card.title, "咨询同款：国风酒盒");
  assert.equal(card.path, "/pages/detail/index?id=doc%20%E9%85%92%20%231");
  assert.equal(card.imageUrl, "https://example.com/cover.jpg");
});

test("falls back through document id, case id, title, and cover image", () => {
  const documentCard = buildCustomerMessageCard({
    caseItem: {
      _id: "doc_002",
      caseId: "case_002",
      coverImageUrl: " https://example.com/document-cover.jpg ",
    },
    imageUrl: "   ",
  });
  const caseCard = buildCustomerMessageCard({
    caseItem: {
      caseId: "case_003",
      title: "案例三",
    },
  });

  assert.equal(documentCard.enabled, true);
  assert.equal(documentCard.title, DEFAULT_CUSTOMER_MESSAGE_TITLE);
  assert.equal(documentCard.path, "/pages/detail/index?id=doc_002");
  assert.equal(documentCard.imageUrl, "https://example.com/document-cover.jpg");
  assert.equal(caseCard.enabled, true);
  assert.equal(caseCard.path, "/pages/detail/index?id=case_003");
  assert.equal(caseCard.imageUrl, "");
});

test("disables the message card when the case has no usable id", () => {
  const card = buildCustomerMessageCard({
    caseItem: {
      title: "没有标识的案例",
      coverImageUrl: "https://example.com/cover.jpg",
    },
  });

  assert.equal(card.enabled, false);
  assert.equal(card.path, "");
  assert.equal(card.title, "咨询同款：没有标识的案例");
  assert.equal(card.imageUrl, "https://example.com/cover.jpg");
});
