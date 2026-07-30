import assert from "node:assert/strict";
import {
  applyMigrationPlan,
  buildMigrationPlan,
  getNextCaseNumber,
  getSequentialCaseNumber,
  parseMigrationArgs,
} from "../scripts/migrate-desktop-admin-data.mjs";

function test(name, callback) {
  try {
    callback();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

async function testAsync(name, callback) {
  try {
    await callback();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function patchMap(plan) {
  return Object.fromEntries(plan.patches.map((item) => [item.documentId, item.changes]));
}

test("accepts only bounded sequential case ids", () => {
  assert.equal(getSequentialCaseNumber("case_001"), 1);
  assert.equal(getSequentialCaseNumber("case_999999"), 999999);
  assert.equal(getSequentialCaseNumber("case_000000"), 0);
  assert.equal(getSequentialCaseNumber("case_1000000"), 0);
  assert.equal(getSequentialCaseNumber("case_1783473800622"), 0);
  assert.equal(getSequentialCaseNumber("draft_120"), 0);
});

test("nextCaseNumber ignores timestamp ids and starts at one for an empty catalog", () => {
  assert.equal(getNextCaseNumber([]), 1);
  assert.equal(
    getNextCaseNumber([
      { caseId: "case_009" },
      { caseId: "case_1783473800622" },
      { caseId: "case_030" },
    ]),
    31
  );
});

test("builds version and homepage order patches without changing current display order", () => {
  const records = [
    {
      _id: "doc_1",
      caseId: "case_001",
      sortOrder: 1,
      version: 3,
      isVisible: true,
      homeSections: { values: ["banner", "popular", "latest"] },
    },
    {
      _id: "doc_timestamp",
      caseId: "case_1783473800622",
      sortOrder: 2,
      isVisible: true,
      homeSections: { values: ["popular", "latest"] },
    },
    {
      _id: "doc_2",
      caseId: "case_002",
      sortOrder: 3,
      isVisible: true,
      homeSections: { values: ["banner", "popular", "latest"] },
    },
    {
      _id: "doc_3",
      caseId: "case_003",
      sortOrder: 3,
      isVisible: true,
      homeSections: { values: ["popular", "latest"] },
    },
    {
      _id: "doc_deleted",
      caseId: "case_004",
      sortOrder: 0,
      isVisible: true,
      deletedAt: "2026-07-30T00:00:00.000Z",
      homeSections: { values: ["banner", "popular", "latest"] },
    },
    {
      _id: "doc_plain",
      caseId: "case_005",
      sortOrder: 8,
      isVisible: true,
      homeSections: { values: [] },
    },
    {
      _id: "doc_hidden",
      caseId: "case_006",
      sortOrder: 0,
      isVisible: false,
      homeSections: { values: ["banner", "popular", "latest"] },
      homeSectionOrder: { banner: 1, popular: 1, latest: 1 },
    },
  ];

  const plan = buildMigrationPlan(records, { _id: "current", revision: 8 });
  const patches = patchMap(plan);

  assert.equal(patches.doc_1.version, undefined);
  assert.deepEqual(patches.doc_1.homeSectionOrder, {
    banner: 1,
    popular: 1,
    latest: 4,
  });
  assert.deepEqual(patches.doc_timestamp.homeSectionOrder, {
    popular: 2,
    latest: 3,
  });
  assert.deepEqual(patches.doc_2.homeSectionOrder, {
    banner: 2,
    popular: 3,
    latest: 1,
  });
  assert.deepEqual(patches.doc_3.homeSectionOrder, {
    popular: 4,
    latest: 2,
  });
  assert.deepEqual(patches.doc_deleted.homeSectionOrder, {});
  assert.deepEqual(patches.doc_plain.homeSectionOrder, {});
  assert.deepEqual(patches.doc_hidden.homeSectionOrder, {});
  assert.equal(patches.doc_timestamp.version, 1);
  assert.deepEqual(plan.sectionCounts, { banner: 2, popular: 4, latest: 4 });
  assert.equal(plan.nextCaseNumber, 7);
  assert.deepEqual(plan.metaPatch, { nextCaseNumber: 7 });
  assert.equal(plan.currentRevision, 8);
});

test("keeps valid existing orders, repairs out-of-range orders and never lowers case allocation", () => {
  const records = [
    {
      _id: "doc_1",
      caseId: "case_009",
      version: 2,
      isVisible: true,
      homeSections: { values: ["popular", "latest"] },
      homeSectionOrder: { popular: 20, latest: 4 },
    },
  ];
  const plan = buildMigrationPlan(records, {
    _id: "current",
    revision: 4,
    nextCaseNumber: 30,
  });

  assert.deepEqual(plan.patches, [
    {
      documentId: "doc_1",
      caseId: "case_009",
      changes: {
        homeSectionOrder: { popular: 1, latest: 4 },
      },
    },
  ]);
  assert.equal(plan.nextCaseNumber, 30);
  assert.deepEqual(plan.metaPatch, {});
});

test("duplicate homepage orders are rebuilt in legacy display order and capped", () => {
  const records = Array.from({ length: 6 }, (_, index) => ({
    _id: `doc_${index + 1}`,
    caseId: `case_00${index + 1}`,
    version: 1,
    isVisible: true,
    sortOrder: index + 1,
    homeSections: { values: ["popular"] },
    homeSectionOrder: index < 2 ? { popular: 1 } : undefined,
  }));
  const plan = buildMigrationPlan(records, {
    _id: "current",
    nextCaseNumber: 7,
    revision: 2,
  });
  const patches = patchMap(plan);

  assert.deepEqual(
    records.map((record) => {
      const patch = patches[record._id];
      return patch ? patch.homeSectionOrder : record.homeSectionOrder;
    }),
    [
      { popular: 1 },
      { popular: 2 },
      { popular: 3 },
      { popular: 4 },
      {},
      {},
    ]
  );
  assert.equal(plan.sectionCounts.popular, 4);
});

test("parses environment defaults and explicit dry-run arguments", () => {
  assert.deepEqual(
    parseMigrationArgs(
      ["--dry-run", "--env", "staging-env", "--page-size", "50"],
      { CLOUDBASE_ENV_ID: "fallback-env" }
    ),
    {
      envId: "staging-env",
      caseCollection: "wine_packaging",
      metaCollection: "catalog_meta",
      pageSize: 50,
      dryRun: true,
      help: false,
    }
  );
  assert.equal(parseMigrationArgs([], { CLOUDBASE_ENV_ID: "from-env" }).envId, "from-env");
  assert.throws(() => parseMigrationArgs(["--page-size", "101"], {}), /1-100/);
  assert.throws(() => parseMigrationArgs(["--unknown"], {}), /未知参数/);
});

await testAsync("dry-run never writes case or metadata documents", async () => {
  const database = {
    collection() {
      throw new Error("dry-run must not access a write collection");
    },
  };
  const result = await applyMigrationPlan(
    database,
    {
      patches: [{ documentId: "doc_1", changes: { version: 1 } }],
      metaPatch: { nextCaseNumber: 2 },
      metaExists: true,
      currentRevision: 1,
    },
    { dryRun: true }
  );
  assert.deepEqual(result, { appliedCases: 0, metaUpdated: false });
});

await testAsync("live migration patches cases then bumps metadata revision once", async () => {
  const calls = [];
  const database = {
    serverDate() {
      return { $serverDate: true };
    },
    command: {
      inc(value) {
        return { $inc: value };
      },
    },
    collection(name) {
      return {
        doc(documentId) {
          return {
            async update(changes) {
              calls.push({ type: "update", name, documentId, changes });
            },
            async set(changes) {
              calls.push({ type: "set", name, documentId, changes });
            },
          };
        },
      };
    },
  };
  const result = await applyMigrationPlan(
    database,
    {
      patches: [
        { documentId: "doc_1", changes: { version: 1 } },
        { documentId: "doc_2", changes: { homeSectionOrder: { latest: 1 } } },
      ],
      metaPatch: { nextCaseNumber: 3 },
      metaExists: true,
      currentRevision: 7,
    },
    { caseCollection: "wine_packaging", metaCollection: "catalog_meta" }
  );

  assert.deepEqual(result, { appliedCases: 2, metaUpdated: true });
  assert.deepEqual(calls, [
    {
      type: "update",
      name: "wine_packaging",
      documentId: "doc_1",
      changes: { version: 1 },
    },
    {
      type: "update",
      name: "wine_packaging",
      documentId: "doc_2",
      changes: { homeSectionOrder: { latest: 1 } },
    },
    {
      type: "update",
      name: "catalog_meta",
      documentId: "current",
      changes: {
        nextCaseNumber: 3,
        revision: { $inc: 1 },
        updatedAt: { $serverDate: true },
      },
    },
  ]);
});
