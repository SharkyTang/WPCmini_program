import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const {
  DISPLAY_LONG_EDGE,
  BANNER_LONG_EDGE,
  BANNER_TARGET_BYTES,
  IMAGE_VARIANT_VERSION,
  MAX_FILES,
  THUMBNAIL_SIZE,
  THUMBNAIL_TARGET_BYTES,
  buildVariantPaths,
  detectSupportedImageType,
  generateVariantBuffers,
  isAdminActor,
  isAdminOpenid,
  isWebAdminUploadFile,
  normalizeSourceFiles,
  resolveAdminActor,
} = require(resolve(
  __dirname,
  "../miniprogram/cloudfunctions/imageProcessor/imageProcessorLogic.js"
));

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

await test("image processor accepts only configured admins", () => {
  assert.equal(isAdminOpenid("admin_2", "admin_1, admin_2"), true);
  assert.equal(isAdminOpenid("spoofed", "admin_1, admin_2"), false);
});

await test("image processor resolves and authorizes CloudBase UIDs", () => {
  const identity = resolveAdminActor({ UID: "web-admin-1" }, {});
  assert.deepEqual(identity, {
    authenticated: true,
    actor: { type: "cloudbase_uid", id: "web-admin-1" },
  });
  assert.equal(
    isAdminActor(identity.actor, { CASE_ADMIN_UIDS: "web-admin-1,web-admin-2" }),
    true
  );
  assert.equal(
    isWebAdminUploadFile(
      "cloud://env/wine-packaging/admin-web/web-admin-1/batch-1/source.webp",
      "web-admin-1"
    ),
    true
  );
});

await test("detects supported image signatures", () => {
  assert.equal(detectSupportedImageType(Buffer.from([
    0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ])), "jpeg");
  assert.equal(detectSupportedImageType(Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
  ])), "png");
  assert.equal(detectSupportedImageType(Buffer.from("not-an-image")), "");
});

await test("source file normalization deduplicates and enforces the nine image limit", () => {
  const files = Array.from(
    { length: 12 },
    (_, index) => `cloud://env/source-${index}.jpg`
  );
  const normalized = normalizeSourceFiles([
    files[0],
    { fileID: files[0] },
    "/tmp/not-cloud.jpg",
    ...files.slice(1),
  ]);
  assert.equal(MAX_FILES, 9);
  assert.equal(normalized.length, MAX_FILES);
  assert.equal(new Set(normalized).size, MAX_FILES);
});

await test("variant paths are deterministic and source-specific", () => {
  const first = buildVariantPaths("cloud://env/source-a.jpg");
  const repeated = buildVariantPaths("cloud://env/source-a.jpg");
  const second = buildVariantPaths("cloud://env/source-b.jpg");
  assert.deepEqual(first, repeated);
  assert.notEqual(first.displayPath, second.displayPath);
  assert.match(first.displayPath, /\/display\.jpg$/);
  assert.match(first.thumbnailPath, /\/thumbnail\.jpg$/);
  assert.match(first.bannerPath, /\/banner\.jpg$/);
  assert.match(first.displayPath, /\/v2\//);
});

await test("generated display, thumbnail and banner images satisfy size bounds", async () => {
  const source = await sharp({
    create: {
      width: 2400,
      height: 1800,
      channels: 3,
      background: "#7b1734",
    },
  }).jpeg({ quality: 95 }).toBuffer();
  const result = await generateVariantBuffers(sharp, source);
  const displayMeta = await sharp(result.displayBuffer).metadata();
  const thumbnailMeta = await sharp(result.thumbnailBuffer).metadata();
  const bannerMeta = await sharp(result.bannerBuffer).metadata();

  assert.equal(Math.max(displayMeta.width, displayMeta.height) <= DISPLAY_LONG_EDGE, true);
  assert.equal(thumbnailMeta.width <= THUMBNAIL_SIZE, true);
  assert.equal(thumbnailMeta.height <= THUMBNAIL_SIZE, true);
  assert.equal(result.thumbnailBuffer.length <= THUMBNAIL_TARGET_BYTES, true);
  assert.equal(Math.max(bannerMeta.width, bannerMeta.height) <= BANNER_LONG_EDGE, true);
  assert.equal(result.bannerBuffer.length <= BANNER_TARGET_BYTES, true);
  assert.equal(result.metadata.thumbnailBytes, result.thumbnailBuffer.length);
  assert.equal(result.metadata.bannerBytes, result.bannerBuffer.length);
  assert.equal(result.metadata.variantVersion, IMAGE_VARIANT_VERSION);
});
