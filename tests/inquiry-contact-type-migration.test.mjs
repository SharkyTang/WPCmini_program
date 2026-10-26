import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPLY_CONFIRMATION,
  main,
  parseMigrationArgs,
  validateMigrationOptions,
} from "../scripts/inquiry-contact-type-migration.mjs";
import {
  CONTACT_TYPE_SOURCE,
  applyMigrationPlan,
  buildMigrationPlan,
  classifyInquiryRecord,
  inferLegacyContactType,
  runInquiryContactTypeMigration,
} from "../scripts/inquiry-contact-type-migration-logic.mjs";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createFakeDatabase(initialRecords = []) {
  const state = new Map(initialRecords.map((record) => [record._id, clone(record)]));
  const stats = {
    transactions: 0,
    updates: 0,
  };

  function documentReference(id) {
    return {
      async get() {
        return { data: state.has(id) ? clone(state.get(id)) : null };
      },
      async update(patch) {
        if (!state.has(id)) throw new Error(`missing document: ${id}`);
        state.set(id, { ...state.get(id), ...clone(patch) });
        stats.updates += 1;
        return { updated: 1 };
      },
    };
  }

  const db = {
    collection(name) {
      assert.equal(name, "inquiries");
      const query = { skip: 0, limit: 100 };
      return {
        skip(value) {
          query.skip = value;
          return this;
        },
        limit(value) {
          query.limit = value;
          return this;
        },
        async get() {
          const records = Array.from(state.values()).map(clone);
          return { data: records.slice(query.skip, query.skip + query.limit) };
        },
        doc(id) {
          return documentReference(id);
        },
      };
    },
    async runTransaction(callback) {
      stats.transactions += 1;
      return callback({
        collection(name) {
          assert.equal(name, "inquiries");
          return {
            doc(id) {
              return documentReference(id);
            },
          };
        },
      });
    },
  };

  return {
    db,
    stats,
    get(id) {
      return state.has(id) ? clone(state.get(id)) : null;
    },
    set(id, record) {
      state.set(id, clone(record));
    },
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

await test("classifies legacy inquiry contacts without overwriting valid existing types", () => {
  assert.deepEqual(inferLegacyContactType(" user@example.com "), {
    contactType: "email",
    source: CONTACT_TYPE_SOURCE,
    reason: "strict_email",
  });
  assert.deepEqual(inferLegacyContactType("+86 138-0013-8000"), {
    contactType: "phone",
    source: CONTACT_TYPE_SOURCE,
    reason: "strict_mainland_phone",
  });
  assert.deepEqual(inferLegacyContactType("qianrun66888"), {
    contactType: "wechat",
    source: CONTACT_TYPE_SOURCE,
    reason: "legacy_nonempty_fallback",
  });
  assert.deepEqual(inferLegacyContactType(""), {
    contactType: "",
    source: "unknown",
    reason: "empty_contact",
  });

  const valid = classifyInquiryRecord({
    _id: "valid",
    contact: "13800138000",
    contactType: " PHONE ",
  });
  assert.equal(valid.action, "skip");
  assert.equal(valid.reason, "valid_existing_contact_type");

  const invalidExisting = classifyInquiryRecord({
    _id: "invalid",
    contact: "user@example.com",
    contactType: "sms",
  });
  assert.equal(invalidExisting.action, "skip");
  assert.equal(invalidExisting.reason, "invalid_existing_contact_type");

  const empty = classifyInquiryRecord({ _id: "empty", contact: "   " });
  assert.equal(empty.action, "skip");
  assert.equal(empty.reason, "empty_contact");
  assert.equal(empty.inference.contactType, "unknown");

  const invalidNumericType = classifyInquiryRecord({
    _id: "invalid-numeric",
    contact: "user@example.com",
    contactType: 0,
  });
  assert.equal(invalidNumericType.action, "skip");
  assert.equal(invalidNumericType.reason, "invalid_existing_contact_type");

  const fallback = classifyInquiryRecord({ _id: "fallback", contact: "11111" });
  assert.equal(fallback.action, "migrate");
  assert.equal(fallback.after.contactType, "wechat");
  assert.equal(fallback.after.contactTypeSource, CONTACT_TYPE_SOURCE);
});

await test("dry-run produces before and after plans without opening write transactions", async () => {
  const fake = createFakeDatabase([
    { _id: "email", contact: "user@example.com", source: "profile" },
    { _id: "phone", contact: "13800138000", source: "detail" },
    { _id: "existing", contact: "wx-user", contactType: "wechat" },
    { _id: "empty", contact: "" },
  ]);

  const result = await runInquiryContactTypeMigration(fake.db, { apply: false });
  assert.equal(result.mode, "dry-run");
  assert.equal(result.summary.scanned, 4);
  assert.equal(result.summary.candidates, 2);
  assert.equal(result.summary.inferredTypes.email, 1);
  assert.equal(result.summary.inferredTypes.phone, 1);
  assert.equal(fake.stats.transactions, 0);
  assert.equal(fake.stats.updates, 0);

  const email = result.entries.find((entry) => entry.id === "email");
  assert.equal(email.before.contactType, null);
  assert.equal(email.after.contactType, "email");
  assert.equal(email.outcome, "planned");
});

await test("apply checks contact and empty contactType again inside the transaction", async () => {
  const records = [
    { _id: "changed-contact", contact: "old-wx" },
    { _id: "filled-type", contact: "user@example.com" },
  ];
  const plan = buildMigrationPlan(records);
  const fake = createFakeDatabase(records);
  fake.set("changed-contact", { _id: "changed-contact", contact: "new-wx" });
  fake.set("filled-type", {
    _id: "filled-type",
    contact: "user@example.com",
    contactType: "email",
  });

  const result = await applyMigrationPlan(fake.db, plan, { batchSize: 2 });
  const changed = result.entries.find((entry) => entry.id === "changed-contact");
  const filled = result.entries.find((entry) => entry.id === "filled-type");
  assert.equal(changed.outcome, "skipped_precondition");
  assert.equal(changed.resultReason, "contact_changed");
  assert.equal(filled.outcome, "skipped_precondition");
  assert.equal(filled.resultReason, "contact_type_no_longer_empty");
  assert.equal(fake.stats.updates, 0);
});

await test("apply is batched and idempotent while preserving the inquiry source field", async () => {
  const fake = createFakeDatabase([
    { _id: "email", contact: "user@example.com", source: "profile" },
    { _id: "phone", contact: "13800138000", source: "detail" },
    { _id: "wechat", contact: "qianrun66888", source: "detail" },
  ]);

  const first = await runInquiryContactTypeMigration(fake.db, {
    apply: true,
    batchSize: 2,
  });
  assert.equal(first.summary.outcomes.updated, 3);
  assert.equal(fake.stats.updates, 3);
  assert.equal(fake.get("email").contactType, "email");
  assert.equal(fake.get("phone").contactType, "phone");
  assert.equal(fake.get("wechat").contactType, "wechat");
  assert.equal(fake.get("email").contactTypeSource, CONTACT_TYPE_SOURCE);
  assert.equal(fake.get("email").source, "profile");
  assert.equal(fake.get("phone").source, "detail");

  const second = await runInquiryContactTypeMigration(fake.db, {
    apply: true,
    batchSize: 2,
  });
  assert.equal(second.summary.candidates, 0);
  assert.equal(second.summary.outcomes.updated || 0, 0);
  assert.equal(fake.stats.updates, 3);
});

await test("write mode requires an explicit environment, verified backup, report, and two confirmations", () => {
  const dryRun = validateMigrationOptions(parseMigrationArgs([
    "--env", "staging-env",
  ], new Date("2026-08-21T00:00:00.000Z")));
  assert.equal(dryRun.apply, false);
  assert.match(dryRun.reportPath, /backups\/inquiry-contact-type-migration-/);

  assert.throws(
    () => validateMigrationOptions(parseMigrationArgs(["--apply"])),
    /--env/
  );
  assert.throws(
    () => parseMigrationArgs(["--env", "test", "--batch-size", "51"]),
    /不能超过/
  );
  assert.throws(
    () => validateMigrationOptions(parseMigrationArgs([
      "--env", "production-env",
      "--apply",
      "--confirm-env", "production-env",
      "--confirm-write", APPLY_CONFIRMATION,
      "--report", "backups/apply.json",
    ])),
    /--backup/
  );
  assert.throws(
    () => validateMigrationOptions(parseMigrationArgs([
      "--env", "production-env",
      "--backup", "backups/example",
      "--apply",
      "--confirm-env", "wrong-env",
      "--confirm-write", APPLY_CONFIRMATION,
      "--report", "backups/apply.json",
    ])),
    /完全一致/
  );

  const approved = validateMigrationOptions(parseMigrationArgs([
    "--env", "production-env",
    "--backup", "backups/example",
    "--report", "backups/apply.json",
    "--apply",
    "--confirm-env", "production-env",
    "--confirm-write", APPLY_CONFIRMATION,
  ]));
  assert.equal(approved.apply, true);
  assert.equal(approved.reportExplicit, true);
});

await test("CLI dry-run can write a private audit report with an injected fake database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inquiry-contact-migration-test-"));
  const reportPath = join(directory, "report.json");
  try {
    const fake = createFakeDatabase([
      { _id: "legacy", contact: "wx-user", source: "profile" },
    ]);
    const report = await main([
      "--env", "test-env",
      "--report", reportPath,
    ], {
      database: fake.db,
      now: new Date("2026-08-21T00:00:00.000Z"),
    });

    const saved = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.mode, "dry-run");
    assert.equal(saved.envId, "test-env");
    assert.equal(saved.entries[0].before.contactType, null);
    assert.equal(saved.entries[0].after.contactType, "wechat");
    assert.equal(fake.stats.updates, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
