import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const {
  DISPLAY_LONG_EDGE,
  MAX_FILES,
  THUMBNAIL_SIZE,
  THUMBNAIL_TARGET_BYTES,
  buildVariantPaths,
  generateVariantBuffers,
  isAdminOpenid,
  normalizeSourceFiles,
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

await test("source file normalization deduplicates and enforces the five image limit", () => {
  const files = Array.from(
    { length: 8 },
    (_, index) => `cloud://env/source-${index}.jpg`
  );
  const normalized = normalizeSourceFiles([
    files[0],
    { fileID: files[0] },
    "/tmp/not-cloud.jpg",
    ...files.slice(1),
  ]);
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
});

await test("generated display and thumbnail images satisfy size bounds", async () => {
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

  assert.equal(Math.max(displayMeta.width, displayMeta.height) <= DISPLAY_LONG_EDGE, true);
  assert.equal(thumbnailMeta.width <= THUMBNAIL_SIZE, true);
  assert.equal(thumbnailMeta.height <= THUMBNAIL_SIZE, true);
  assert.equal(result.thumbnailBuffer.length <= THUMBNAIL_TARGET_BYTES, true);
  assert.equal(result.metadata.thumbnailBytes, result.thumbnailBuffer.length);
});
