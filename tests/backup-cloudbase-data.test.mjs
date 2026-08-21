import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BACKUP_SCHEMA_VERSION,
  DEFAULT_COLLECTIONS,
  INQUIRY_FOLLOWUP_COLLECTIONS,
  LEGACY_COLLECTIONS_V2,
  createBackup,
  parseArgs,
  serializeRecords,
  sha256,
  validateBackupManifest,
} from "../scripts/backup-cloudbase-data.mjs";
import {
  assertCollectionsEmpty,
  buildRestorePlan,
  parseRestoreArgs,
} from "../scripts/restore-cloudbase-data.mjs";

function createDatabase(recordsByCollection, options = {}) {
  const missingCollections = new Set(options.missingCollections || []);
  return {
    collection(name) {
      const state = { skip: 0, limit: 100 };
      return {
        skip(value) {
          state.skip = value;
          return this;
        },
        limit(value) {
          state.limit = value;
          return this;
        },
        async get() {
          if (missingCollections.has(name)) {
            const error = new Error(`collection ${name} not exist`);
            error.code = "DATABASE_COLLECTION_NOT_EXIST";
            throw error;
          }
          const records = recordsByCollection[name] || [];
          return { data: records.slice(state.skip, state.skip + state.limit) };
        },
        async count() {
          return { total: (recordsByCollection[name] || []).length };
        },
      };
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

await test("backup scope includes every current user, content, contact, and notification collection", () => {
  assert.equal(DEFAULT_COLLECTIONS.length, 17);
  for (const required of [
    "contact_settings",
    "user_profiles",
    "favorites",
    "browse_history",
    "inquiries",
    "inquiry_messages",
    "inquiry_alert_jobs",
    "inquiry_reply_subscriptions",
    "inquiry_admin_events",
    "feedback",
    "notification_subscriptions",
    "notification_push_jobs",
    "notification_delivery_logs",
  ]) {
    assert.equal(DEFAULT_COLLECTIONS.includes(required), true, required);
  }
});

await test("backup before collection creation records missing follow-up collections as audited empties", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cloudbase-pre-schema-backup-"));
  try {
    const records = Object.fromEntries(
      LEGACY_COLLECTIONS_V2.map((name) => [name, name === "catalog_meta"
        ? [{ _id: "current" }]
        : []])
    );
    const result = await createBackup({
      db: createDatabase(records, {
        missingCollections: INQUIRY_FOLLOWUP_COLLECTIONS,
      }),
      envId: "pre-schema-env",
      outputDir: directory,
      now: new Date("2026-08-20T00:00:00.000Z"),
    });
    assert.deepEqual(
      result.manifest.sourceMissingCollections,
      INQUIRY_FOLLOWUP_COLLECTIONS
    );
    for (const name of INQUIRY_FOLLOWUP_COLLECTIONS) {
      assert.equal(result.manifest.collections[name].count, 0);
      assert.equal(result.manifest.collections[name].sourceMissing, true);
    }
    assert.equal(validateBackupManifest(directory).valid, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("legacy schema v2 backups remain verifiable and restorable", () => {
  const directory = mkdtempSync(join(tmpdir(), "cloudbase-v2-backup-"));
  try {
    const manifest = {
      schemaVersion: 2,
      status: "complete",
      envId: "legacy-source",
      createdAt: "2026-08-01T00:00:00.000Z",
      collections: {},
      catalogMetaCurrentFound: true,
    };
    for (const name of LEGACY_COLLECTIONS_V2) {
      const records = [{
        _id: name === "catalog_meta" ? "current" : `${name}_legacy`,
      }];
      const content = serializeRecords(records);
      writeFileSync(resolve(directory, `${name}.json`), content, "utf8");
      manifest.collections[name] = {
        filename: `${name}.json`,
        count: 1,
        sha256: sha256(content),
      };
    }
    writeFileSync(
      resolve(directory, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );
    const verified = validateBackupManifest(directory);
    assert.equal(verified.schemaVersion, 2);
    assert.equal(verified.collectionNames.length, 13);
    const plan = buildRestorePlan(directory, "legacy-recovery");
    assert.equal(plan.schemaVersion, 2);
    assert.equal(plan.totalCollections, 13);
    assert.equal(plan.totalDocuments, 13);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("backup writes a complete checksummed manifest and restore plan", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cloudbase-backup-test-"));
  try {
    const records = Object.fromEntries(
      DEFAULT_COLLECTIONS.map((name) => [name, [{
        _id: name === "catalog_meta" ? "current" : `${name}_1`,
        value: name,
      }]])
    );
    const result = await createBackup({
      db: createDatabase(records),
      envId: "source-env",
      outputDir: directory,
      now: new Date("2026-08-01T00:00:00.000Z"),
    });
    assert.equal(result.manifest.schemaVersion, BACKUP_SCHEMA_VERSION);
    assert.equal(result.manifest.status, "complete");
    assert.equal(result.manifest.scope.cloudStorage, false);
    const verified = validateBackupManifest(directory);
    assert.equal(verified.valid, true);
    assert.equal(Object.keys(verified.collections).length, 17);
    const plan = buildRestorePlan(directory, "recovery-env");
    assert.equal(plan.sourceEnv, "source-env");
    assert.equal(plan.targetEnv, "recovery-env");
    assert.equal(plan.totalDocuments, 17);

    const casePath = resolve(directory, "wine_packaging.json");
    const original = readFileSync(casePath, "utf8");
    writeFileSync(casePath, original.replace("wine_packaging", "tampered"), "utf8");
    assert.throws(
      () => validateBackupManifest(directory),
      /校验失败/
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("backup and restore CLIs require explicit paths and matching apply confirmation", () => {
  assert.equal(parseArgs(["legacy-env"]).envId, "legacy-env");
  assert.throws(() => parseArgs(["--verify"]), /--verify/);
  const preview = parseRestoreArgs([
    "--backup", "backups/example", "--target-env", "recovery-env",
  ]);
  assert.equal(preview.apply, false);
  assert.equal(preview.targetEnv, "recovery-env");
  assert.throws(
    () => parseRestoreArgs([
      "--backup", "backups/example",
      "--target-env", "recovery-env",
      "--confirm-env", "wrong-env",
      "--apply",
    ]),
    /完全一致/
  );
});

await test("safe restore refuses a target containing any existing document", async () => {
  const records = Object.fromEntries(DEFAULT_COLLECTIONS.map((name) => [name, []]));
  records.favorites = [{ _id: "existing_favorite" }];
  await assert.rejects(
    () => assertCollectionsEmpty(createDatabase(records)),
    /favorites 已有 1 条数据/
  );
});
