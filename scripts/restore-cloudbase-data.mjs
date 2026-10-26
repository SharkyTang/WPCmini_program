import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_COLLECTIONS, parseEnvFile, validateBackupManifest } from "./backup-cloudbase-data.mjs";

function parseRestoreArgs(argv = process.argv.slice(2)) {
  const options = {
    apply: false,
    allowSourceEnv: false,
    backupDir: "",
    targetEnv: "",
    confirmEnv: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--backup") {
      options.backupDir = resolve(argv[index + 1] || "");
      index += 1;
    } else if (value === "--target-env") {
      options.targetEnv = argv[index + 1] || "";
      index += 1;
    } else if (value === "--confirm-env") {
      options.confirmEnv = argv[index + 1] || "";
      index += 1;
    } else if (value === "--apply") {
      options.apply = true;
    } else if (value === "--allow-source-env") {
      options.allowSourceEnv = true;
    } else {
      throw new Error(`未知参数：${value}`);
    }
  }
  if (!options.backupDir || options.backupDir === resolve("")) {
    throw new Error("--backup 需要备份目录");
  }
  if (!options.targetEnv) throw new Error("--target-env 不能为空");
  if (options.apply && options.confirmEnv !== options.targetEnv) {
    throw new Error("执行恢复时 --confirm-env 必须与 --target-env 完全一致");
  }
  return options;
}

function loadLocalEnv(envPath = ".env.local") {
  if (!existsSync(envPath)) return;
  const values = parseEnvFile(readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function buildRestorePlan(backupDir, targetEnv) {
  const verification = validateBackupManifest(backupDir);
  const collectionNames = verification.collectionNames;
  return {
    sourceEnv: verification.envId,
    targetEnv,
    schemaVersion: verification.schemaVersion,
    totalCollections: collectionNames.length,
    totalDocuments: Object.values(verification.collections)
      .reduce((total, item) => total + item.count, 0),
    collections: collectionNames.map((name) => ({
      name,
      count: verification.collections[name].count,
    })),
  };
}

async function assertCollectionsEmpty(db, collectionNames = DEFAULT_COLLECTIONS) {
  for (const collectionName of collectionNames) {
    const response = await db.collection(collectionName).count();
    const total = Number(response && response.total) || 0;
    if (total > 0) {
      throw new Error(
        `目标环境集合 ${collectionName} 已有 ${total} 条数据；安全恢复只允许写入空集合`
      );
    }
  }
}

async function restoreIntoEmptyCollections(
  db,
  backupDir,
  collectionNames = DEFAULT_COLLECTIONS
) {
  const restored = {};
  for (const collectionName of collectionNames) {
    const records = JSON.parse(
      readFileSync(resolve(backupDir, `${collectionName}.json`), "utf8")
    );
    let count = 0;
    for (const record of records) {
      // add with the original _id fails on any concurrent/conflicting record;
      // unlike doc.set it can never overwrite target data.
      await db.collection(collectionName).add({ data: record });
      count += 1;
    }
    restored[collectionName] = count;
  }
  return restored;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseRestoreArgs(argv);
  const plan = buildRestorePlan(options.backupDir, options.targetEnv);
  if (plan.sourceEnv === options.targetEnv && !options.allowSourceEnv) {
    throw new Error(
      "默认禁止直接恢复到备份来源环境；请先恢复到独立环境验证，确需原环境时显式添加 --allow-source-env"
    );
  }
  console.log(`CloudBase 恢复计划：${plan.sourceEnv} -> ${plan.targetEnv}`);
  console.log(`- ${plan.totalCollections} 个集合，${plan.totalDocuments} 条文档`);
  if (!options.apply) {
    console.log("- 当前为只读预检；添加 --apply 和匹配的 --confirm-env 后才会写入");
    return { applied: false, plan };
  }

  loadLocalEnv();
  const secretId = process.env.TENCENTCLOUD_SECRET_ID;
  const secretKey = process.env.TENCENTCLOUD_SECRET_KEY;
  if (!secretId || !secretKey) {
    throw new Error("缺少腾讯云凭证，请配置 .env.local 后重试");
  }
  const { default: cloudbase } = await import("@cloudbase/node-sdk");
  const app = cloudbase.init({ env: options.targetEnv, secretId, secretKey });
  const db = app.database();
  const collectionNames = plan.collections.map((item) => item.name);
  await assertCollectionsEmpty(db, collectionNames);
  const restored = await restoreIntoEmptyCollections(
    db,
    options.backupDir,
    collectionNames
  );
  console.log("CloudBase 数据已写入空的恢复环境，请继续执行文档中的校验，暂勿切换正式流量");
  return { applied: true, plan, restored };
}

const executedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

export {
  assertCollectionsEmpty,
  buildRestorePlan,
  parseRestoreArgs,
  restoreIntoEmptyCollections,
};
