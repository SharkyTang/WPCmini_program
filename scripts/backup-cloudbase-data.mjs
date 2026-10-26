import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const BACKUP_SCHEMA_VERSION = 3;
const DEFAULT_ENV_ID = "cloud1-d3gznsms746425a42";
const LEGACY_COLLECTIONS_V2 = Object.freeze([
  "wine_packaging",
  "home_banners",
  "catalog_meta",
  "contact_settings",
  "user_profiles",
  "favorites",
  "browse_history",
  "inquiries",
  "feedback",
  "app_notifications",
  "notification_subscriptions",
  "notification_push_jobs",
  "notification_delivery_logs",
]);
const INQUIRY_FOLLOWUP_COLLECTIONS = Object.freeze([
  "inquiry_messages",
  "inquiry_alert_jobs",
  "inquiry_reply_subscriptions",
  "inquiry_admin_events",
]);
const DEFAULT_COLLECTIONS = Object.freeze([
  ...LEGACY_COLLECTIONS_V2.slice(0, 8),
  ...INQUIRY_FOLLOWUP_COLLECTIONS,
  ...LEGACY_COLLECTIONS_V2.slice(8),
]);
const PAGE_SIZE = 100;

function getCollectionsForSchemaVersion(schemaVersion) {
  if (schemaVersion === 2) return LEGACY_COLLECTIONS_V2;
  if (schemaVersion === 3) return DEFAULT_COLLECTIONS;
  return null;
}

function isMissingCollectionError(error) {
  const code = error && (error.errCode || error.code);
  const message = error && (error.errMsg || error.message);
  return (
    code === "DATABASE_COLLECTION_NOT_EXIST"
    || code === "COLLECTION_NOT_EXIST"
    || /collection.*(?:not exist|not found)|集合.*不存在/i.test(message || "")
  );
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
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
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

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function serializeRecords(records) {
  return `${JSON.stringify(records, null, 2)}\n`;
}

function writePrivateFile(filePath, content) {
  writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
  chmodSync(filePath, 0o600);
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    envId: DEFAULT_ENV_ID,
    outputDir: "",
    verifyDir: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--verify") {
      options.verifyDir = resolve(argv[index + 1] || "");
      index += 1;
    } else if (value === "--env") {
      options.envId = argv[index + 1] || DEFAULT_ENV_ID;
      index += 1;
    } else if (value === "--output") {
      options.outputDir = resolve(argv[index + 1] || "");
      index += 1;
    } else if (!value.startsWith("--")) {
      // Keep the original `node ... <envId>` invocation compatible.
      options.envId = value;
    } else {
      throw new Error(`未知参数：${value}`);
    }
  }
  if (options.verifyDir === resolve("")) {
    throw new Error("--verify 需要备份目录");
  }
  return options;
}

async function fetchCollection(db, collectionName) {
  const records = [];
  let offset = 0;
  while (true) {
    const response = await db
      .collection(collectionName)
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

function validateCollectionRecords(collectionName, records) {
  if (!Array.isArray(records)) {
    throw new Error(`${collectionName} 备份内容不是数组`);
  }
  const ids = new Set();
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`${collectionName} 包含无效文档`);
    }
    const id = typeof record._id === "string" ? record._id.trim() : "";
    if (!id) throw new Error(`${collectionName} 包含缺少 _id 的文档`);
    if (ids.has(id)) throw new Error(`${collectionName} 包含重复文档 ID：${id}`);
    ids.add(id);
  }
  return ids.size;
}

function validateBackupManifest(backupDir, manifestInput) {
  const directory = resolve(backupDir);
  const manifest = manifestInput || JSON.parse(
    readFileSync(resolve(directory, "manifest.json"), "utf8")
  );
  const collectionNames = manifest
    ? getCollectionsForSchemaVersion(manifest.schemaVersion)
    : null;
  if (!manifest || !collectionNames) {
    throw new Error("备份清单版本无效");
  }
  if (manifest.status !== "complete" || !manifest.envId) {
    throw new Error("备份尚未完整生成");
  }
  if (!manifest.collections || typeof manifest.collections !== "object") {
    throw new Error("备份清单缺少集合信息");
  }

  const summary = {};
  for (const collectionName of collectionNames) {
    const info = manifest.collections[collectionName];
    if (!info) throw new Error(`备份缺少集合：${collectionName}`);
    const expectedFilename = `${collectionName}.json`;
    if (info.filename !== expectedFilename || basename(info.filename) !== info.filename) {
      throw new Error(`${collectionName} 的备份文件名无效`);
    }
    const filePath = resolve(directory, info.filename);
    if (!existsSync(filePath)) throw new Error(`备份文件不存在：${info.filename}`);
    const content = readFileSync(filePath, "utf8");
    if (sha256(content) !== info.sha256) {
      throw new Error(`备份文件校验失败：${info.filename}`);
    }
    const records = JSON.parse(content);
    const count = validateCollectionRecords(collectionName, records);
    if (count !== info.count) {
      throw new Error(`${collectionName} 文档数量与清单不一致`);
    }
    if (info.sourceMissing === true) {
      if (
        manifest.schemaVersion !== 3
        || !INQUIRY_FOLLOWUP_COLLECTIONS.includes(collectionName)
        || count !== 0
      ) {
        throw new Error(`${collectionName} 的源集合缺失标记无效`);
      }
    }
    summary[collectionName] = { count, sha256: info.sha256 };
  }

  const catalogRecords = JSON.parse(
    readFileSync(resolve(directory, manifest.collections.catalog_meta.filename), "utf8")
  );
  const currentMetaFound = catalogRecords.some((record) => record._id === "current");
  if (currentMetaFound !== manifest.catalogMetaCurrentFound) {
    throw new Error("catalog_meta/current 校验结果与清单不一致");
  }
  return {
    valid: true,
    schemaVersion: manifest.schemaVersion,
    envId: manifest.envId,
    createdAt: manifest.createdAt,
    collectionNames: [...collectionNames],
    collections: summary,
  };
}

async function createBackup({ db, envId, outputDir, now = new Date() }) {
  const directory = outputDir
    ? resolve(outputDir)
    : resolve("backups", `cloudbase-${envId}-${formatTimestamp(now)}`);
  if (existsSync(directory) && readdirSync(directory).length) {
    throw new Error(`备份目录不是空目录：${directory}`);
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const manifest = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    status: "building",
    envId,
    createdAt: now.toISOString(),
    scope: {
      database: true,
      cloudStorage: false,
    },
    collections: {},
    sourceMissingCollections: [],
  };

  for (const collectionName of DEFAULT_COLLECTIONS) {
    let records;
    let sourceMissing = false;
    try {
      records = await fetchCollection(db, collectionName);
    } catch (error) {
      if (
        !INQUIRY_FOLLOWUP_COLLECTIONS.includes(collectionName)
        || !isMissingCollectionError(error)
      ) {
        throw error;
      }
      records = [];
      sourceMissing = true;
      manifest.sourceMissingCollections.push(collectionName);
    }
    validateCollectionRecords(collectionName, records);
    const filename = `${collectionName}.json`;
    const content = serializeRecords(records);
    writePrivateFile(resolve(directory, filename), content);
    manifest.collections[collectionName] = {
      filename,
      count: records.length,
      sha256: sha256(content),
      sourceMissing,
    };
  }

  const catalogMetaRecords = JSON.parse(
    readFileSync(resolve(directory, manifest.collections.catalog_meta.filename), "utf8")
  );
  const currentMeta = catalogMetaRecords.find((record) => record._id === "current") || null;
  writePrivateFile(
    resolve(directory, "catalog_meta-current.json"),
    `${JSON.stringify(currentMeta, null, 2)}\n`
  );
  manifest.catalogMetaCurrentFound = Boolean(currentMeta);
  manifest.status = "complete";
  writePrivateFile(
    resolve(directory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  validateBackupManifest(directory, manifest);
  return { directory, manifest };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.verifyDir) {
    const result = validateBackupManifest(options.verifyDir);
    console.log(`CloudBase 备份校验通过：${options.verifyDir}`);
    console.log(`- 环境：${result.envId}`);
    console.log(`- 集合：${Object.keys(result.collections).length} 个`);
    return result;
  }

  loadLocalEnv();
  const secretId = process.env.TENCENTCLOUD_SECRET_ID;
  const secretKey = process.env.TENCENTCLOUD_SECRET_KEY;
  if (!secretId || !secretKey) {
    throw new Error("缺少腾讯云凭证，请配置 .env.local 后重试");
  }
  const { default: cloudbase } = await import("@cloudbase/node-sdk");
  const app = cloudbase.init({ env: options.envId, secretId, secretKey });
  const result = await createBackup({
    db: app.database(),
    envId: options.envId,
    outputDir: options.outputDir,
  });
  console.log(`CloudBase 备份完成：${result.directory}`);
  for (const [name, info] of Object.entries(result.manifest.collections)) {
    console.log(`- ${name}: ${info.count} 条`);
  }
  console.log(`- catalog_meta/current: ${result.manifest.catalogMetaCurrentFound ? "已记录" : "未找到"}`);
  console.log("- 云存储文件不在本脚本备份范围内，请按恢复文档单独保全");
  return result;
}

const executedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

export {
  BACKUP_SCHEMA_VERSION,
  DEFAULT_COLLECTIONS,
  INQUIRY_FOLLOWUP_COLLECTIONS,
  LEGACY_COLLECTIONS_V2,
  createBackup,
  fetchCollection,
  getCollectionsForSchemaVersion,
  isMissingCollectionError,
  parseArgs,
  parseEnvFile,
  serializeRecords,
  sha256,
  validateBackupManifest,
  validateCollectionRecords,
};
