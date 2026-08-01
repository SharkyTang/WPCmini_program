import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const {
  DISPLAY_LONG_EDGE,
  DISPLAY_TARGET_BYTES,
  BANNER_LONG_EDGE,
  BANNER_TARGET_BYTES,
  IMAGE_VARIANT_VERSION,
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
const { createJimpSharpCompat } = require(resolve(
  __dirname,
  "../miniprogram/cloudfunctions/imageProcessor/jimpSharpCompat.js"
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

async function createHighEntropyJpeg(width, height) {
  const pixels = Buffer.allocUnsafe(width * height * 3);
  let state = 0x12345678;
  for (let index = 0; index < pixels.length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    pixels[index] = state >>> 24;
  }
  return sharp(pixels, {
    raw: {
      width,
      height,
      channels: 3,
    },
  }).jpeg({ quality: 95 }).toBuffer();
}

function createFakeJimp() {
  class FakeImage {
    constructor(width = 2400, height = 2400) {
      this.bitmap = { width, height };
      this.jpegQuality = 80;
    }

    exifRotate() {
      return this;
    }

    clone() {
      const copy = new FakeImage(this.bitmap.width, this.bitmap.height);
      copy.jpegQuality = this.jpegQuality;
      return copy;
    }

    resize(width, height) {
      this.bitmap.width = width;
      this.bitmap.height = height;
      return this;
    }

    cover(width, height) {
      this.bitmap.width = width;
      this.bitmap.height = height;
      return this;
    }

    quality(value) {
      this.jpegQuality = value;
      return this;
    }

    async getBufferAsync() {
      const bytes = Math.ceil(
        (this.bitmap.width * this.bitmap.height * this.jpegQuality) / 250
      );
      return Buffer.alloc(bytes);
    }
  }

  return {
    HORIZONTAL_ALIGN_CENTER: 1,
    MIME_JPEG: "image/jpeg",
    RESIZE_BILINEAR: "bilinear",
    VERTICAL_ALIGN_MIDDLE: 2,
    read: async () => new FakeImage(),
  };
}

await test("image processor accepts only configured admins", () => {
  assert.equal(isAdminOpenid("admin_2", "admin_1, admin_2"), true);
  assert.equal(isAdminOpenid("spoofed", "admin_1, admin_2"), false);
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
  assert.equal(result.displayBuffer.length <= DISPLAY_TARGET_BYTES, true);
  assert.equal(thumbnailMeta.width <= THUMBNAIL_SIZE, true);
  assert.equal(thumbnailMeta.height <= THUMBNAIL_SIZE, true);
  assert.equal(result.thumbnailBuffer.length <= THUMBNAIL_TARGET_BYTES, true);
  assert.equal(Math.max(bannerMeta.width, bannerMeta.height) <= BANNER_LONG_EDGE, true);
  assert.equal(result.bannerBuffer.length <= BANNER_TARGET_BYTES, true);
  assert.equal(result.metadata.thumbnailBytes, result.thumbnailBuffer.length);
  assert.equal(result.metadata.displayBytes, result.displayBuffer.length);
  assert.equal(result.metadata.displayQuality, 80);
  assert.equal(result.metadata.bannerBytes, result.bannerBuffer.length);
  assert.equal(result.metadata.variantVersion, IMAGE_VARIANT_VERSION);
});

await test("display quality adapts when a detailed image exceeds the byte target", async () => {
  const source = await createHighEntropyJpeg(1800, 1800);
  const fixedQualityDisplay = await sharp(source, { failOn: "none" })
    .resize({
      width: DISPLAY_LONG_EDGE,
      height: DISPLAY_LONG_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 80, mozjpeg: true })
    .toBuffer();
  assert.equal(fixedQualityDisplay.length > DISPLAY_TARGET_BYTES, true);

  const result = await generateVariantBuffers(sharp, source);
  assert.equal(result.displayBuffer.length <= DISPLAY_TARGET_BYTES, true);
  assert.equal(result.metadata.displayBytes, result.displayBuffer.length);
  assert.equal(result.metadata.displayQuality < 80, true);
  assert.equal(result.metadata.displayQuality >= 20, true);
  assert.equal(result.metadata.variantVersion, 2);
  assert.match(buildVariantPaths("cloud://env/detailed.jpg").displayPath, /\/v2\//);
});

await test("display byte targeting works through the Jimp compatibility adapter", async () => {
  const imageFactory = createJimpSharpCompat(createFakeJimp(), "test");
  const result = await generateVariantBuffers(imageFactory, Buffer.from("source"));

  assert.equal(result.metadata.width, 2400);
  assert.equal(result.metadata.height, 2400);
  assert.equal(result.metadata.displayQuality, 24);
  assert.equal(result.metadata.displayBytes, result.displayBuffer.length);
  assert.equal(result.displayBuffer.length <= DISPLAY_TARGET_BYTES, true);
  assert.equal(result.thumbnailBuffer.length <= THUMBNAIL_TARGET_BYTES, true);
  assert.equal(result.bannerBuffer.length <= BANNER_TARGET_BYTES, true);
});
