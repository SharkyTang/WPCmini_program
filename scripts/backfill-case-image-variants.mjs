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
const DEFAULT_BANNER_COLLECTION = "home_banners";
const DEFAULT_CHECKPOINT = ".case-variant-v2-backfill.json";
const IMAGE_VARIANT_VERSION = 2;
const CASE_GALLERY_MAX = 9;
const PAGE_SIZE = 100;
const BATCH_SIZE = 5;

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

export function parseBackfillArgs(argv) {
  const options = {
    envId: DEFAULT_ENV_ID,
    collection: DEFAULT_COLLECTION,
    bannerCollection: DEFAULT_BANNER_COLLECTION,
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
    } else if (arg === "--banner-collection") {
      options.bannerCollection = next;
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
--banner-collection    独立 Banner 集合，默认 home_banners
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

async function fetchAllRecords(app, collectionName, orderField = "sortOrder") {
  const records = [];
  let offset = 0;
  while (true) {
    const response = await app
      .database()
      .collection(collectionName)
      .orderBy(orderField, "asc")
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
  ).slice(0, CASE_GALLERY_MAX);
}

export function needsVariantBackfill(record = {}) {
  const gallery = normalizeFileIDs(record.galleryImages, [record.coverImage]);
  const sources = normalizeFileIDs(record.sourceGalleryImages);
  const thumbnails = normalizeFileIDs(record.galleryThumbnails);
  const banners = normalizeFileIDs(record.galleryBanners);
  const hasAliasedThumbnail = gallery.some((fileID, index) => {
    const thumbnail = thumbnails[index];
    const source = sources[index];
    return Boolean(thumbnail && (thumbnail === fileID || thumbnail === source));
  });
  return Boolean(
    gallery.length &&
    (
      Number(record.imageVariantVersion) < IMAGE_VARIANT_VERSION ||
      sources.length !== gallery.length ||
      thumbnails.length !== gallery.length ||
      banners.length !== gallery.length ||
      !record.coverThumbnail ||
      !record.coverBanner ||
      hasAliasedThumbnail
    )
  );
}

export function needsBannerBackfill(record = {}) {
  const image = normalizeFileIDs([record.image || record.coverImage])[0] || "";
  const optimizedImage = normalizeFileIDs([record.optimizedImage])[0] || "";
  return Boolean(
    image &&
    (
      Number(record.imageVariantVersion) < IMAGE_VARIANT_VERSION ||
      !optimizedImage ||
      optimizedImage === image
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

export function selectBannerBackfillCandidates(
  candidates = [],
  options = {},
  checkpoint = null
) {
  const completedBannerIds = new Set(
    checkpoint && Array.isArray(checkpoint.completedBannerIds)
      ? checkpoint.completedBannerIds
      : []
  );
  const remaining = candidates.filter((item) => !completedBannerIds.has(item._id));
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
  const [displayFileID, thumbnailFileID, bannerFileID] = await Promise.all([
    uploadVariant(app, paths.displayPath, buffers.displayBuffer),
    uploadVariant(app, paths.thumbnailPath, buffers.thumbnailBuffer),
    uploadVariant(app, paths.bannerPath, buffers.bannerBuffer),
  ]);
  if (!displayFileID || !thumbnailFileID || !bannerFileID) {
    throw new Error(`变体上传失败：${sourceFileID}`);
  }
  return {
    sourceFileID,
    displayFileID,
    thumbnailFileID,
    bannerFileID,
    variantVersion: IMAGE_VARIANT_VERSION,
    ...buffers.metadata,
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
  const galleryBanners = variants.map((item) => item.bannerFileID);
  await app.database().collection(collectionName).doc(record._id).update({
    sourceGalleryImages: sources,
    galleryImages,
    galleryThumbnails,
    galleryBanners,
    coverImage: galleryImages[0],
    coverThumbnail: galleryThumbnails[0],
    coverBanner: galleryBanners[0],
    imageVariantVersion: IMAGE_VARIANT_VERSION,
    updatedAt: app.database().serverDate(),
  });
}

async function processBanner(app, collectionName, record) {
  const sourceFileID = normalizeFileIDs([record.image || record.coverImage])[0];
  if (!sourceFileID) throw new Error(`Banner 缺少原图：${record._id}`);
  const download = await app.downloadFile({ fileID: sourceFileID });
  const buffers = await generateVariantBuffers(sharp, download.fileContent);
  const paths = buildVariantPaths(sourceFileID);
  const optimizedImage = await uploadVariant(
    app,
    paths.bannerPath,
    buffers.bannerBuffer
  );
  if (!optimizedImage) throw new Error(`Banner 优化图上传失败：${record._id}`);
  await app.database().collection(collectionName).doc(record._id).update({
    optimizedImage,
    imageVariantVersion: IMAGE_VARIANT_VERSION,
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
  const [allCases, allBanners] = await Promise.all([
    fetchAllRecords(app, options.collection),
    fetchAllRecords(app, options.bannerCollection),
  ]);
  const caseCandidates = allCases.filter(needsVariantBackfill);
  const bannerCandidates = allBanners.filter(needsBannerBackfill);
  const checkpoint = options.resume ? readCheckpoint(options.checkpoint) : null;
  const completedCaseIds = new Set(
    checkpoint && Array.isArray(checkpoint.completedCaseIds)
      ? checkpoint.completedCaseIds
      : []
  );
  const completedBannerIds = new Set(
    checkpoint && Array.isArray(checkpoint.completedBannerIds)
      ? checkpoint.completedBannerIds
      : []
  );
  const failedCaseIds = new Set(
    checkpoint && Array.isArray(checkpoint.failedCaseIds)
      ? checkpoint.failedCaseIds
      : []
  );
  const failedBannerIds = new Set(
    checkpoint && Array.isArray(checkpoint.failedBannerIds)
      ? checkpoint.failedBannerIds
      : []
  );
  const currentCaseCandidateIds = new Set(caseCandidates.map((item) => item._id));
  const currentBannerCandidateIds = new Set(bannerCandidates.map((item) => item._id));
  Array.from(failedCaseIds).forEach((id) => {
    if (!currentCaseCandidateIds.has(id)) failedCaseIds.delete(id);
  });
  Array.from(failedBannerIds).forEach((id) => {
    if (!currentBannerCandidateIds.has(id)) failedBannerIds.delete(id);
  });
  const selectedCases = selectBackfillCandidates(
    caseCandidates,
    options,
    checkpoint
  );
  const remainingLimit = options.limit
    ? Math.max(0, options.limit - selectedCases.length)
    : 0;
  const selectedBanners =
    options.limit && remainingLimit === 0
      ? []
      : selectBannerBackfillCandidates(
          bannerCandidates,
          { ...options, limit: options.limit ? remainingLimit : 0 },
          checkpoint
        );
  console.log(
    `待回填 ${selectedCases.length} 条案例、${selectedBanners.length} 条独立 Banner，批次大小 ${BATCH_SIZE}`
  );
  if (options.dryRun) {
    selectedCases.slice(0, 20).forEach((item, index) => {
      console.log(`案例 ${index + 1}. ${item._id} ${item.title || ""}`);
    });
    selectedBanners.slice(0, 20).forEach((item, index) => {
      console.log(`Banner ${index + 1}. ${item._id} ${item.title || ""}`);
    });
    return;
  }

  let revisionBumped = checkpoint && checkpoint.revisionBumped === true;
  if (caseCandidates.length || bannerCandidates.length) revisionBumped = false;
  const saveProgress = (last = {}) => {
    writeCheckpoint(options.checkpoint, {
      version: IMAGE_VARIANT_VERSION,
      lastCaseId: last.caseId || "",
      lastBannerId: last.bannerId || "",
      completedCaseIds: Array.from(completedCaseIds),
      failedCaseIds: Array.from(failedCaseIds),
      completedBannerIds: Array.from(completedBannerIds),
      failedBannerIds: Array.from(failedBannerIds),
      revisionBumped,
      updatedAt: new Date().toISOString(),
    });
  };

  for (let index = 0; index < selectedCases.length; index += 1) {
    const record = selectedCases[index];
    try {
      await processCase(app, options.collection, record);
      completedCaseIds.add(record._id);
      failedCaseIds.delete(record._id);
      console.log(`案例已完成 ${index + 1}/${selectedCases.length}: ${record._id}`);
    } catch (error) {
      failedCaseIds.add(record._id);
      console.error(`处理失败 ${record._id}: ${error.message}`);
    }
    saveProgress({ caseId: record._id });
    if ((index + 1) % BATCH_SIZE === 0) {
      console.log(
        `案例批次完成：累计成功 ${completedCaseIds.size}，失败 ${failedCaseIds.size}`
      );
    }
  }

  for (let index = 0; index < selectedBanners.length; index += 1) {
    const record = selectedBanners[index];
    try {
      await processBanner(app, options.bannerCollection, record);
      completedBannerIds.add(record._id);
      failedBannerIds.delete(record._id);
      console.log(`Banner 已完成 ${index + 1}/${selectedBanners.length}: ${record._id}`);
    } catch (error) {
      failedBannerIds.add(record._id);
      console.error(`Banner 处理失败 ${record._id}: ${error.message}`);
    }
    saveProgress({ bannerId: record._id });
    if ((index + 1) % BATCH_SIZE === 0) {
      console.log(
        `Banner 批次完成：累计成功 ${completedBannerIds.size}，失败 ${failedBannerIds.size}`
      );
    }
  }

  const unfinishedCases = caseCandidates.filter(
    (record) => !completedCaseIds.has(record._id)
  );
  const unfinishedBanners = bannerCandidates.filter(
    (record) => !completedBannerIds.has(record._id)
  );
  const migrationComplete =
    !unfinishedCases.length &&
    !unfinishedBanners.length &&
    !failedCaseIds.size &&
    !failedBannerIds.size;
  if (
    migrationComplete &&
    !revisionBumped &&
    (completedCaseIds.size || completedBannerIds.size)
  ) {
    await bumpCatalogRevision(app);
    revisionBumped = true;
    saveProgress();
  }
  console.log(
    `回填结束：案例成功 ${completedCaseIds.size}、失败 ${failedCaseIds.size}；Banner 成功 ${completedBannerIds.size}、失败 ${failedBannerIds.size}；待处理 ${unfinishedCases.length + unfinishedBanners.length}`
  );
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
