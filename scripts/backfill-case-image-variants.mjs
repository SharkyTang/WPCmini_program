import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { loadLocalEnv } from "./import-wine-packaging.mjs";

const require = createRequire(import.meta.url);
const {
  buildVariantPaths,
  generateVariantBuffers,
} = require("../miniprogram/cloudfunctions/imageProcessor/imageProcessorLogic.js");

const DEFAULT_ENV_ID = "cloud1-d3gznsms746425a42";
const DEFAULT_COLLECTION = "wine_packaging";
const DEFAULT_CHECKPOINT = ".case-variant-backfill.json";
const PAGE_SIZE = 100;
const BATCH_SIZE = 10;

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

export function parseBackfillArgs(argv) {
  const options = {
    envId: DEFAULT_ENV_ID,
    collection: DEFAULT_COLLECTION,
    start: 1,
    limit: 0,
    dryRun: false,
    resume: false,
    checkpoint: DEFAULT_CHECKPOINT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--env") {
      options.envId = next;
      index += 1;
    } else if (arg === "--collection") {
      options.collection = next;
      index += 1;
    } else if (arg === "--start") {
      options.start = parseNumber(next, 1);
      index += 1;
    } else if (arg === "--limit") {
      options.limit = parseNumber(next, 0);
      index += 1;
    } else if (arg === "--checkpoint") {
      options.checkpoint = next;
      index += 1;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--resume") {
      options.resume = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    }
  }
  options.start = Math.max(1, options.start);
  options.checkpoint = resolve(options.checkpoint);
  return options;
}

function printHelp() {
  console.log(`用法:
node scripts/backfill-case-image-variants.mjs --dry-run --limit 5
node scripts/backfill-case-image-variants.mjs --limit 10
node scripts/backfill-case-image-variants.mjs --resume

选项:
--env <envId>          云开发环境 ID
--collection <name>    案例集合，默认 wine_packaging
--start <n>            从第 n 条开始
--limit <n>            最多处理 n 条，0 表示全部
--checkpoint <path>    断点文件路径
--dry-run              只列出计划，不下载、上传或更新
--resume               从断点文件继续`);
}

async function createCloudbaseApp(envId) {
  loadLocalEnv();
  const { default: cloudbase } = await import("@cloudbase/node-sdk");
  const secretId = process.env.TENCENTCLOUD_SECRET_ID;
  const secretKey = process.env.TENCENTCLOUD_SECRET_KEY;
  if (!secretId || !secretKey) {
    throw new Error("缺少腾讯云凭证，请配置 TENCENTCLOUD_SECRET_ID 和 TENCENTCLOUD_SECRET_KEY");
  }
  return cloudbase.init({
    env: envId,
    secretId,
    secretKey,
  });
}

async function fetchAllCases(app, collectionName) {
  const records = [];
  let offset = 0;
  while (true) {
    const response = await app
      .database()
      .collection(collectionName)
      .orderBy("sortOrder", "asc")
      .skip(offset)
      .limit(PAGE_SIZE)
      .get();
    const page = response.data || [];
    records.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return records;
}

function normalizeFileIDs(value, fallback = []) {
  const source = Array.isArray(value) && value.length ? value : fallback;
  return Array.from(
    new Set(
      (source || []).filter(
        (fileID) => typeof fileID === "string" && fileID.startsWith("cloud://")
      )
    )
  ).slice(0, 5);
}

export function needsVariantBackfill(record = {}) {
  const gallery = normalizeFileIDs(record.galleryImages, [record.coverImage]);
  const sources = normalizeFileIDs(record.sourceGalleryImages);
  const thumbnails = normalizeFileIDs(record.galleryThumbnails);
  return Boolean(
    gallery.length &&
    (
      sources.length !== gallery.length ||
      thumbnails.length !== gallery.length ||
      !record.coverThumbnail
    )
  );
}

export function selectBackfillCandidates(candidates = [], options = {}, checkpoint = null) {
  const completedCaseIds = new Set(
    checkpoint && Array.isArray(checkpoint.completedCaseIds)
      ? checkpoint.completedCaseIds
      : []
  );
  const start = Math.max(1, Number(options.start) || 1) - 1;
  const remaining = candidates
    .slice(start)
    .filter((item) => !completedCaseIds.has(item._id));
  const limit = Math.max(0, Number(options.limit) || 0);
  return limit > 0 ? remaining.slice(0, limit) : remaining;
}

function readCheckpoint(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeCheckpoint(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function uploadVariant(app, cloudPath, fileContent) {
  const response = await app.uploadFile({ cloudPath, fileContent });
  return response.fileID || response.fileId || "";
}

async function processSource(app, sourceFileID) {
  const download = await app.downloadFile({ fileID: sourceFileID });
  const buffers = await generateVariantBuffers(sharp, download.fileContent);
  const paths = buildVariantPaths(sourceFileID);
  const [displayFileID, thumbnailFileID] = await Promise.all([
    uploadVariant(app, paths.displayPath, buffers.displayBuffer),
    uploadVariant(app, paths.thumbnailPath, buffers.thumbnailBuffer),
  ]);
  if (!displayFileID || !thumbnailFileID) {
    throw new Error(`变体上传失败：${sourceFileID}`);
  }
  return {
    sourceFileID,
    displayFileID,
    thumbnailFileID,
  };
}

async function processCase(app, collectionName, record) {
  const sources = normalizeFileIDs(
    record.sourceGalleryImages,
    normalizeFileIDs(record.galleryImages, [record.coverImage])
  );
  const variants = [];
  for (const sourceFileID of sources) {
    variants.push(await processSource(app, sourceFileID));
  }
  if (!variants.length || variants.length !== sources.length) {
    throw new Error(`案例图片变体不完整：${record._id}`);
  }
  const galleryImages = variants.map((item) => item.displayFileID);
  const galleryThumbnails = variants.map((item) => item.thumbnailFileID);
  await app.database().collection(collectionName).doc(record._id).update({
    sourceGalleryImages: sources,
    galleryImages,
    galleryThumbnails,
    coverImage: galleryImages[0],
    coverThumbnail: galleryThumbnails[0],
    updatedAt: app.database().serverDate(),
  });
}

async function bumpCatalogRevision(app) {
  const database = app.database();
  try {
    await database.collection("catalog_meta").doc("current").update({
      revision: database.command.inc(1),
      updatedAt: database.serverDate(),
    });
  } catch (error) {
    await database.collection("catalog_meta").doc("current").set({
      revision: 1,
      updatedAt: database.serverDate(),
    });
  }
}

async function run(options) {
  const app = await createCloudbaseApp(options.envId);
  const allCases = await fetchAllCases(app, options.collection);
  const candidates = allCases.filter(needsVariantBackfill);
  const checkpoint = options.resume ? readCheckpoint(options.checkpoint) : null;
  const completedCaseIds = new Set(
    checkpoint && Array.isArray(checkpoint.completedCaseIds)
      ? checkpoint.completedCaseIds
      : []
  );
  const failedCaseIds = new Set(
    checkpoint && Array.isArray(checkpoint.failedCaseIds)
      ? checkpoint.failedCaseIds
      : []
  );
  const selected = selectBackfillCandidates(candidates, options, checkpoint);
  console.log(`待回填 ${selected.length} 条案例，批次大小 ${BATCH_SIZE}`);
  if (options.dryRun) {
    selected.slice(0, 20).forEach((item, index) => {
      console.log(`${index + 1}. ${item._id} ${item.title || ""}`);
    });
    return;
  }

  let succeeded = completedCaseIds.size;
  let failed = failedCaseIds.size;
  let newlySucceeded = 0;
  for (let index = 0; index < selected.length; index += 1) {
    const record = selected[index];
    try {
      await processCase(app, options.collection, record);
      succeeded += 1;
      newlySucceeded += 1;
      completedCaseIds.add(record._id);
      if (failedCaseIds.delete(record._id)) failed -= 1;
      console.log(`已完成 ${index + 1}/${selected.length}: ${record._id}`);
    } catch (error) {
      if (!failedCaseIds.has(record._id)) failed += 1;
      failedCaseIds.add(record._id);
      console.error(`处理失败 ${record._id}: ${error.message}`);
    }
    writeCheckpoint(options.checkpoint, {
      lastCaseId: record._id,
      succeeded,
      failed,
      completedCaseIds: Array.from(completedCaseIds),
      failedCaseIds: Array.from(failedCaseIds),
      updatedAt: new Date().toISOString(),
    });
    if ((index + 1) % BATCH_SIZE === 0) {
      console.log(`批次完成：成功 ${succeeded}，失败 ${failed}`);
    }
  }
  if (newlySucceeded) await bumpCatalogRevision(app);
  console.log(`回填完成：成功 ${succeeded}，失败 ${failed}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseBackfillArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
  } else {
    run(options).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
