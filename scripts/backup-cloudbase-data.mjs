import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_COLLECTIONS = ["wine_packaging", "home_banners", "catalog_meta"];
const PAGE_SIZE = 100;

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
    env[key] = value;
    return env;
  }, {});
}

function loadLocalEnv(envPath = ".env.local") {
  if (!existsSync(envPath)) return;
  const env = parseEnvFile(readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function formatTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

export function parseBackupArgs(argv = [], env = process.env) {
  const options = {
    envId: String(env.CLOUDBASE_ENV_ID || env.TCB_ENV_ID || "").trim(),
    outputDir: "",
    help: false,
  };
  let positionalEnvUsed = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === "--env") {
      options.envId = String(next || "").trim();
      index += 1;
    } else if (argument === "--output") {
      options.outputDir = String(next || "").trim();
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (!argument.startsWith("-") && !positionalEnvUsed) {
      // 兼容旧命令 `npm run backup:cloudbase -- <env-id>`。
      options.envId = argument;
      positionalEnvUsed = true;
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  return options;
}

function collectCloudFileReferences(value, path, references) {
  if (typeof value === "string") {
    if (value.startsWith("cloud://")) references.push({ fileID: value, field: path });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectCloudFileReferences(item, `${path}[${index}]`, references);
    });
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    collectCloudFileReferences(item, path ? `${path}.${key}` : key, references);
  }
}

export function buildCloudFileManifest(collections = {}) {
  const files = new Map();
  for (const [collection, records] of Object.entries(collections)) {
    for (const record of records) {
      const references = [];
      collectCloudFileReferences(record, "", references);
      for (const reference of references) {
        if (!files.has(reference.fileID)) files.set(reference.fileID, []);
        files.get(reference.fileID).push({
          collection,
          documentId: record._id || record.caseId || "",
          field: reference.field,
        });
      }
    }
  }
  return Array.from(files.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([fileID, references]) => ({ fileID, references }));
}

async function fetchCollection(db, collectionName) {
  const records = [];
  let offset = 0;
  while (true) {
    const response = await db
      .collection(collectionName)
      .orderBy("_id", "asc")
      .skip(offset)
      .limit(PAGE_SIZE)
      .get();
    const page = Array.isArray(response.data) ? response.data : [];
    records.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return records;
}

async function main() {
  loadLocalEnv();
  const options = parseBackupArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`用法:
  npm run backup:cloudbase -- --env <env-id>
  npm run backup:cloudbase -- --env <env-id> --output <directory>

环境 ID 也可通过 CLOUDBASE_ENV_ID 提供。备份包含集合 JSON、SHA-256 校验和及被数据库引用的云文件清单。
`);
    return;
  }
  const secretId = process.env.TENCENTCLOUD_SECRET_ID;
  const secretKey = process.env.TENCENTCLOUD_SECRET_KEY;
  const sessionToken =
    process.env.TENCENTCLOUD_SESSION_TOKEN ||
    process.env.TENCENTCLOUD_SESSIONTOKEN ||
    "";
  if (!secretId || !secretKey) {
    throw new Error("缺少腾讯云凭证，请配置 .env.local 后重试");
  }

  const envId = options.envId;
  if (!envId) {
    throw new Error("缺少 CloudBase 环境 ID：请使用 --env 或设置 CLOUDBASE_ENV_ID");
  }
  const outputDir = options.outputDir
    ? resolve(options.outputDir)
    : resolve("backups", `cloudbase-${envId}-${formatTimestamp()}`);
  mkdirSync(outputDir, { recursive: true });

  const { default: cloudbase } = await import("@cloudbase/node-sdk");
  const app = cloudbase.init({
    env: envId,
    secretId,
    secretKey,
    ...(sessionToken ? { sessionToken } : {}),
  });
  const db = app.database();
  const manifest = {
    envId,
    createdAt: new Date().toISOString(),
    collections: {},
  };
  const backedUpCollections = {};

  for (const collectionName of DEFAULT_COLLECTIONS) {
    const records = await fetchCollection(db, collectionName);
    const filename = `${collectionName}.json`;
    const content = `${JSON.stringify(records, null, 2)}\n`;
    writeFileSync(resolve(outputDir, filename), content, "utf8");
    backedUpCollections[collectionName] = records;
    manifest.collections[collectionName] = {
      filename,
      count: records.length,
      sha256: sha256(content),
    };
  }

  const catalogMetaRecords = backedUpCollections.catalog_meta;
  const currentMeta = catalogMetaRecords.find((record) => record._id === "current") || null;
  const currentMetaContent = `${JSON.stringify(currentMeta, null, 2)}\n`;
  writeFileSync(resolve(outputDir, "catalog_meta-current.json"), currentMetaContent, "utf8");
  manifest.catalogMetaCurrentFound = Boolean(currentMeta);
  manifest.catalogMetaCurrent = {
    filename: "catalog_meta-current.json",
    sha256: sha256(currentMetaContent),
  };

  const storageFiles = buildCloudFileManifest(backedUpCollections);
  const storageManifestContent = `${JSON.stringify(
    {
      envId,
      createdAt: manifest.createdAt,
      note: "仅列出数据库记录引用的 cloud:// 文件；此清单不包含文件二进制副本。",
      files: storageFiles,
    },
    null,
    2
  )}\n`;
  writeFileSync(resolve(outputDir, "storage-files.json"), storageManifestContent, "utf8");
  manifest.storageFiles = {
    filename: "storage-files.json",
    count: storageFiles.length,
    sha256: sha256(storageManifestContent),
  };

  writeFileSync(
    resolve(outputDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );

  console.log(`CloudBase 备份完成：${outputDir}`);
  for (const [name, info] of Object.entries(manifest.collections)) {
    console.log(`- ${name}: ${info.count} 条`);
  }
  console.log(`- catalog_meta/current: ${currentMeta ? "已记录" : "未找到"}`);
  console.log(`- 云文件引用：${storageFiles.length} 个`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
