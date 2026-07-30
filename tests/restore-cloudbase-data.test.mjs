import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../scripts/backup-cloudbase-data.mjs";
import {
  inspectRestoreTarget,
  parseRestoreArgs,
  restoreBackup,
} from "../scripts/restore-cloudbase-data.mjs";

async function test(name, callback) {
  try {
    await callback();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function createBackupFixture() {
  const directory = mkdtempSync(join(tmpdir(), "wine-admin-backup-"));
  const collections = {
    wine_packaging: [
      {
        _id: "case_doc_1",
        caseId: "case_001",
        coverImage: "cloud://source/case.jpg",
      },
    ],
    home_banners: [],
    catalog_meta: [{ _id: "current", revision: 4, nextCaseNumber: 2 }],
  };
  const manifest = {
    envId: "source-env",
    createdAt: "2026-07-30T00:00:00.000Z",
    collections: {},
  };

  for (const [name, records] of Object.entries(collections)) {
    const filename = `${name}.json`;
    const content = `${JSON.stringify(records, null, 2)}\n`;
    writeFileSync(join(directory, filename), content);
    manifest.collections[name] = {
      filename,
      count: records.length,
      sha256: sha256(content),
    };
  }

  const currentMetaContent = `${JSON.stringify(collections.catalog_meta[0], null, 2)}\n`;
  writeFileSync(join(directory, "catalog_meta-current.json"), currentMetaContent);
  manifest.catalogMetaCurrent = {
    filename: "catalog_meta-current.json",
    sha256: sha256(currentMetaContent),
  };

  const storageContent = `${JSON.stringify(
    {
      envId: "source-env",
      files: [{ fileID: "cloud://source/case.jpg", references: [] }],
    },
    null,
    2
  )}\n`;
  writeFileSync(join(directory, "storage-files.json"), storageContent);
  manifest.storageFiles = {
    filename: "storage-files.json",
    count: 1,
    sha256: sha256(storageContent),
  };
  writeFileSync(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return directory;
}

function createFakeDatabase(initialCounts = {}) {
  const records = Object.fromEntries(
    Object.entries(initialCounts).map(([name, count]) => [
      name,
      new Map(
        Array.from({ length: count }, (_, index) => [
          `existing_${index}`,
          { value: index },
        ])
      ),
    ])
  );
  return {
    records,
    collection(name) {
      if (!records[name]) records[name] = new Map();
      return {
        async count() {
          return { total: records[name].size };
        },
        doc(documentId) {
          return {
            async set(data) {
              records[name].set(documentId, data);
            },
          };
        },
      };
    },
  };
}

await test("restore CLI requires an explicit mode and double confirmation for apply", () => {
  assert.deepEqual(
    parseRestoreArgs(
      ["--source", "backup", "--env", "staging", "--dry-run"],
      {}
    ),
    {
      source: "backup",
      envId: "staging",
      confirmEnv: "",
      dryRun: true,
      apply: false,
      help: false,
    }
  );
  assert.throws(() => parseRestoreArgs([], {}), /--dry-run 或 --apply/);
  assert.throws(
    () => parseRestoreArgs(["--env", "prod", "--apply", "--confirm-env", "other"], {}),
    /完全一致/
  );
  assert.throws(
    () => parseRestoreArgs(["--dry-run", "--apply"], {}),
    /不能同时使用/
  );
  assert.equal(parseRestoreArgs(["--apply", "--help"], {}).help, true);
});

await test("target inspection rejects any non-empty collection", async () => {
  const database = createFakeDatabase({ wine_packaging: 0, catalog_meta: 1 });
  const result = await inspectRestoreTarget(database, {
    wine_packaging: [],
    catalog_meta: [],
  });
  assert.deepEqual(result, {
    targetCounts: { wine_packaging: 0, catalog_meta: 1 },
    canApply: false,
  });
});

await test("dry-run validates the backup but writes nothing", async () => {
  const directory = createBackupFixture();
  try {
    const database = createFakeDatabase();
    const result = await restoreBackup(database, directory, {
      envId: "empty-staging",
      dryRun: true,
    });
    assert.equal(result.applied, false);
    assert.equal(result.canApply, true);
    assert.equal(database.records.wine_packaging.size, 0);
    assert.equal(database.records.catalog_meta.size, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("apply restores ids only into empty collections and verifies counts", async () => {
  const directory = createBackupFixture();
  try {
    const database = createFakeDatabase();
    const result = await restoreBackup(database, directory, {
      envId: "empty-staging",
      confirmEnv: "empty-staging",
      apply: true,
    });
    assert.equal(result.applied, true);
    assert.equal(result.written, 2);
    assert.deepEqual(
      database.records.wine_packaging.get("case_doc_1"),
      {
        caseId: "case_001",
        coverImage: "cloud://source/case.jpg",
      }
    );
    assert.deepEqual(database.records.catalog_meta.get("current"), {
      revision: 4,
      nextCaseNumber: 2,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
