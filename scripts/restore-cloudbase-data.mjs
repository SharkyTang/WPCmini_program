import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyBackupDirectory } from "./verify-cloudbase-backup.mjs";

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseEnvFile(content) {
  return content.split(/\r?\n/).reduce((env, line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return env;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex < 1) return env;
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) env[key] = value;
    return env;
  }, {});
}

function loadLocalEnv(envPath = ".env.local") {
  if (!existsSync(envPath)) return;
  const values = parseEnvFile(readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function parseRestoreArgs(argv = [], env = process.env) {
  const options = {
    source: "",
    envId: trimText(env.CLOUDBASE_ENV_ID || env.TCB_ENV_ID),
    confirmEnv: "",
    dryRun: false,
    apply: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === "--source") {
      options.source = trimText(next);
      index += 1;
    } else if (argument === "--env") {
      options.envId = trimText(next);
      index += 1;
    } else if (argument === "--confirm-env") {
      options.confirmEnv = trimText(next);
      index += 1;
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--apply") {
      options.apply = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }

  if (!options.help && options.dryRun && options.apply) {
    throw new Error("--dry-run 与 --apply 不能同时使用");
  }
  if (!options.help && !options.dryRun && !options.apply) {
    throw new Error("必须明确指定 --dry-run 或 --apply");
  }
  if (!options.help && options.apply && options.confirmEnv !== options.envId) {
    throw new Error("--apply 要求 --confirm-env 与 --env 完全一致");
  }
  return options;
}

function loadBackupCollections(sourceDirectory) {
  const source = resolve(sourceDirectory);
  const manifest = JSON.parse(readFileSync(resolve(source, "manifest.json"), "utf8"));
  const collections = Object.fromEntries(
    Object.entries(manifest.collections || {}).map(([name, info]) => {
      const records = JSON.parse(readFileSync(resolve(source, info.filename), "utf8"));
      if (!Array.isArray(records)) throw new Error(`${info.filename} 不是 JSON 数组`);
      for (const record of records) {
        if (!trimText(record && record._id)) {
          throw new Error(`${name} 中存在缺少 _id 的记录，无法安全恢复`);
        }
      }
      return [name, records];
    })
  );
  return { manifest, collections };
}

export async function inspectRestoreTarget(database, collections) {
  const targetCounts = {};
  for (const name of Object.keys(collections)) {
    const response = await database.collection(name).count();
    targetCounts[name] = Number(response && response.total) || 0;
  }
  return {
    targetCounts,
    canApply: Object.values(targetCounts).every((count) => count === 0),
  };
}

export async function restoreBackup(database, sourceDirectory, options = {}) {
  const verification = verifyBackupDirectory(sourceDirectory);
  const { manifest, collections } = loadBackupCollections(sourceDirectory);
  const inspection = await inspectRestoreTarget(database, collections);
  const plan = {
    sourceEnvId: manifest.envId || "",
    targetEnvId: options.envId || "",
    collections: Object.fromEntries(
      Object.entries(collections).map(([name, records]) => [
        name,
        {
          sourceCount: records.length,
          targetCount: inspection.targetCounts[name],
        },
      ])
    ),
    storageFileCount: verification.storageFileCount,
    canApply: inspection.canApply,
  };

  if (options.dryRun) return { ...plan, applied: false };
  if (!options.apply) throw new Error("恢复写入必须显式设置 --apply");
  if (options.confirmEnv !== options.envId) {
    throw new Error("恢复写入要求 confirmEnv 与目标 envId 完全一致");
  }
  if (!inspection.canApply) {
    throw new Error("目标集合不是全空；脚本拒绝覆盖或合并现有数据");
  }

  let written = 0;
  for (const [name, records] of Object.entries(collections)) {
    for (const record of records) {
      const { _id: documentId, ...data } = record;
      await database.collection(name).doc(documentId).set(data);
      written += 1;
    }
  }

  const after = await inspectRestoreTarget(database, collections);
  for (const [name, records] of Object.entries(collections)) {
    if (after.targetCounts[name] !== records.length) {
      throw new Error(
        `${name} 恢复后数量不一致：预期 ${records.length}，实际 ${after.targetCounts[name]}`
      );
    }
  }
  return { ...plan, applied: true, written, restoredCounts: after.targetCounts };
}

async function createDatabase(envId) {
  const secretId = process.env.TENCENTCLOUD_SECRET_ID;
  const secretKey = process.env.TENCENTCLOUD_SECRET_KEY;
  const sessionToken =
    process.env.TENCENTCLOUD_SESSION_TOKEN ||
    process.env.TENCENTCLOUD_SESSIONTOKEN ||
    "";
  if (!secretId || !secretKey) {
    throw new Error(
      "缺少服务端凭证：请在 .env.local 中设置 TENCENTCLOUD_SECRET_ID 和 TENCENTCLOUD_SECRET_KEY"
    );
  }
  const { default: cloudbase } = await import("@cloudbase/node-sdk");
  const app = cloudbase.init({
    env: envId,
    secretId,
    secretKey,
    ...(sessionToken ? { sessionToken } : {}),
  });
  return app.database();
}

function printHelp() {
  console.log(`用法:
  npm run restore:cloudbase:dry -- --source <backup-directory> --env <staging-env-id>
  npm run restore:cloudbase -- --source <backup-directory> --env <env-id> --confirm-env <env-id>

安全限制:
  - --dry-run 只校验备份和目标集合数量。
  - --apply 必须带完全相同的 --confirm-env。
  - 目标集合必须全部为空；脚本不删除、不覆盖、不合并现有记录。
  - storage-files.json 只校验引用清单，不恢复云文件二进制。
`);
}

function printPlan(result) {
  console.log(result.applied ? "CloudBase 数据恢复完成" : "CloudBase 数据恢复预览（未写入）");
  console.log(`- 备份环境：${result.sourceEnvId || "未知"}`);
  console.log(`- 目标环境：${result.targetEnvId}`);
  for (const [name, counts] of Object.entries(result.collections)) {
    console.log(
      `- ${name}: 备份 ${counts.sourceCount} 条，目标当前 ${counts.targetCount} 条`
    );
  }
  console.log(`- 云文件引用：${result.storageFileCount} 个（不含二进制恢复）`);
  console.log(`- 允许写入：${result.canApply ? "是（目标集合全空）" : "否"}`);
}

async function main() {
  loadLocalEnv();
  const options = parseRestoreArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.source) throw new Error("缺少 --source <backup-directory>");
  if (!options.envId) {
    throw new Error("缺少目标环境 ID：请使用 --env 或设置 CLOUDBASE_ENV_ID");
  }
  const database = await createDatabase(options.envId);
  const result = await restoreBackup(database, options.source, options);
  printPlan(result);
  if (options.dryRun && !result.canApply) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
