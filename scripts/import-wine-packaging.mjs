import { existsSync, readFileSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ENV_ID = "cloud1-d3gznsms746425a42";
const DEFAULT_COLLECTION = "wine_packaging";
const DEFAULT_STORAGE_PREFIX = "wine-packaging/cases";
const MULTI_FIELDS = ["packageTypes", "styles", "scenes", "statuses", "keywords"];

function toArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (Array.isArray(value.values)) return value.values.filter(Boolean);
  if (typeof value === "string") return value ? [value] : [];
  return [];
}

function toJsonValues(value) {
  return { values: toArray(value) };
}

function toNumber(value, fallback = 9999) {
  const nextValue = Number(value);
  return Number.isFinite(nextValue) ? nextValue : fallback;
}

function cleanPrefix(prefix) {
  return prefix.replace(/^\/+|\/+$/g, "");
}

export function buildCloudPath(storagePrefix, record) {
  const fileName = record.uploadFileName || record.originalFileName || `${record.id}.jpg`;
  return posix.join(cleanPrefix(storagePrefix), basename(fileName));
}

export function resolveImagePath(imagesDir, record) {
  const fileName = record.uploadFileName || record.originalFileName || `${record.id}.jpg`;
  return join(imagesDir, fileName);
}

export function mapCaseToWinePackagingDoc(record, coverImageFileId) {
  const doc = {
    caseId: record.caseId || record.id,
    title: record.title || record.id || "未命名案例",
    coverImage: coverImageFileId || record.imageFileID || "",
    wineType: record.wineType || "白酒",
    priceLevel: record.priceLevel || "",
    notes: record.notes || "",
    isVisible: record.isVisible !== false,
    sortOrder: toNumber(record.sortOrder),
  };

  MULTI_FIELDS.forEach((field) => {
    doc[field] = toJsonValues(record[field]);
  });

  return doc;
}

export function parseImportArgs(argv) {
  const args = {
    casesPath: "export/cases.json",
    imagesDir: "export/optimized-images",
    envId: DEFAULT_ENV_ID,
    collection: DEFAULT_COLLECTION,
    storagePrefix: DEFAULT_STORAGE_PREFIX,
    start: 1,
    limit: 0,
    dryRun: false,
    skipUpload: false,
    skipExisting: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--cases") {
      args.casesPath = next;
      index += 1;
    } else if (arg === "--images") {
      args.imagesDir = next;
      index += 1;
    } else if (arg === "--env") {
      args.envId = next;
      index += 1;
    } else if (arg === "--collection") {
      args.collection = next;
      index += 1;
    } else if (arg === "--storage-prefix") {
      args.storagePrefix = next;
      index += 1;
    } else if (arg === "--limit") {
      args.limit = toNumber(next, 0);
      index += 1;
    } else if (arg === "--start") {
      args.start = toNumber(next, 1);
      index += 1;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--skip-upload") {
      args.skipUpload = true;
    } else if (arg === "--skip-existing") {
      args.skipExisting = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    }
  }

  args.start = Math.max(1, Math.floor(args.start));

  return args;
}

function readCases(casesPath) {
  if (!existsSync(casesPath)) {
    throw new Error(`找不到 cases.json：${casesPath}`);
  }
  const parsed = JSON.parse(readFileSync(casesPath, "utf8"));
  const cases = Array.isArray(parsed) ? parsed : parsed.cases;
  if (!Array.isArray(cases)) {
    throw new Error("cases.json 必须是数组，或包含 cases 数组。");
  }
  return cases;
}

function assertImagesExist(records, imagesDir) {
  const missing = records
    .map((record) => ({
      id: record.id,
      path: resolveImagePath(imagesDir, record),
    }))
    .filter((item) => !existsSync(item.path));

  if (missing.length) {
    const preview = missing
      .slice(0, 5)
      .map((item) => `${item.id}: ${item.path}`)
      .join("\n");
    throw new Error(`有 ${missing.length} 张图片找不到：\n${preview}`);
  }
}

export function parseEnvFile(content) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .reduce((env, line) => {
      const separatorIndex = line.indexOf("=");
      if (separatorIndex === -1) return env;

      const key = line.slice(0, separatorIndex).trim();
      let value = line.slice(separatorIndex + 1).trim();
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

export function loadLocalEnv(envPath = ".env.local") {
  if (!existsSync(envPath)) return false;

  const env = parseEnvFile(readFileSync(envPath, "utf8"));
  Object.entries(env).forEach(([key, value]) => {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  });

  return true;
}

async function createCloudbaseApp(envId) {
  loadLocalEnv();
  const { default: cloudbase } = await import("@cloudbase/node-sdk");
  const secretId = process.env.TENCENTCLOUD_SECRET_ID;
  const secretKey = process.env.TENCENTCLOUD_SECRET_KEY;

  if (!secretId || !secretKey) {
    throw new Error(
      "缺少腾讯云凭证：请设置 TENCENTCLOUD_SECRET_ID 和 TENCENTCLOUD_SECRET_KEY。"
    );
  }

  return cloudbase.init({
    env: envId,
    secretId,
    secretKey,
  });
}

async function uploadImage(app, imagePath, cloudPath) {
  const response = await app.uploadFile({
    cloudPath,
    fileContent: readFileSync(imagePath),
  });
  return response.fileID || response.fileId || response.fileid;
}

async function addDocument(app, collection, doc) {
  return app.database().collection(collection).add(doc);
}

async function documentExists(app, collection, caseId) {
  const response = await app
    .database()
    .collection(collection)
    .where({ caseId })
    .limit(1)
    .get();
  return Array.isArray(response.data) && response.data.length > 0;
}

async function importCases(options) {
  const allCases = readCases(options.casesPath);
  const startIndex = options.start - 1;
  const remainingCases = allCases.slice(startIndex);
  const cases = options.limit > 0 ? remainingCases.slice(0, options.limit) : remainingCases;
  assertImagesExist(cases, options.imagesDir);

  const dryRunDocs = cases.map((record) =>
    mapCaseToWinePackagingDoc(
      record,
      record.imageFileID || `cloud://${options.envId}/${buildCloudPath(options.storagePrefix, record)}`
    )
  );

  if (options.dryRun) {
    console.log(`dry-run: 将导入 ${dryRunDocs.length} 条到 ${options.collection}`);
    console.log(JSON.stringify(dryRunDocs.slice(0, 3), null, 2));
    return { imported: 0, planned: dryRunDocs.length };
  }

  const app = await createCloudbaseApp(options.envId);
  let imported = 0;
  let skipped = 0;

  for (const record of cases) {
    const caseId = record.caseId || record.id;
    if (options.skipExisting && (await documentExists(app, options.collection, caseId))) {
      skipped += 1;
      console.log(`已跳过 ${skipped}: ${caseId} 已存在`);
      continue;
    }

    const imagePath = resolveImagePath(options.imagesDir, record);
    const cloudPath = buildCloudPath(options.storagePrefix, record);
    const fileId = options.skipUpload
      ? record.imageFileID
      : await uploadImage(app, imagePath, cloudPath);

    if (!fileId) {
      throw new Error(`图片上传失败或缺少 imageFileID：${record.id}`);
    }

    const doc = mapCaseToWinePackagingDoc(record, fileId);
    await addDocument(app, options.collection, doc);
    imported += 1;
    console.log(`已导入 ${imported}/${cases.length}: ${doc.caseId}`);
  }

  return { imported, skipped, planned: cases.length };
}

function printHelp() {
  console.log(`用法:
node scripts/import-wine-packaging.mjs --dry-run
node scripts/import-wine-packaging.mjs --cases export/cases.json --images export/optimized-images --limit 10 --dry-run

真实导入前需要:
1. npm install @cloudbase/node-sdk
2. 设置 TENCENTCLOUD_SECRET_ID 和 TENCENTCLOUD_SECRET_KEY
   可以用终端 export，也可以放在项目根目录 .env.local

常用参数:
--cases <path>             默认 export/cases.json
--images <dir>             默认 export/optimized-images
--env <envId>              默认 ${DEFAULT_ENV_ID}
--collection <name>        默认 ${DEFAULT_COLLECTION}
--storage-prefix <prefix>  默认 ${DEFAULT_STORAGE_PREFIX}
--start <number>           从第 N 条开始导入，默认 1
--limit <number>           只导入前 N 条，0 表示全部
--dry-run                  只检查和预览，不上传、不写库
--skip-upload              不上传图片，直接使用 cases.json 里的 imageFileID
--skip-existing            如果 caseId 已存在则跳过，避免重复导入
`);
}

async function main() {
  const options = parseImportArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const result = await importCases(options);
  const skippedText = result.skipped ? `，跳过 ${result.skipped} 条` : "";
  console.log(`完成：计划 ${result.planned} 条，实际导入 ${result.imported} 条${skippedText}。`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
