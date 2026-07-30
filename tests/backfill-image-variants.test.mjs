import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  needsVariantBackfill,
  needsBannerBackfill,
  parseBackfillArgs,
  selectBackfillCandidates,
} from "../scripts/backfill-case-image-variants.mjs";

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("backfill CLI supports dry-run, limit, start and resume", () => {
  const options = parseBackfillArgs([
    "--dry-run",
    "--limit",
    "5",
    "--start",
    "3",
    "--resume",
    "--checkpoint",
    "tmp/checkpoint.json",
  ]);
  assert.equal(options.dryRun, true);
  assert.equal(options.resume, true);
  assert.equal(options.limit, 5);
  assert.equal(options.start, 3);
  assert.equal(options.checkpoint, resolve("tmp/checkpoint.json"));
});

test("backfill skips complete variants and accepts legacy records", () => {
  const source = "cloud://env/source.jpg";
  const display = "cloud://env/display.jpg";
  const thumbnail = "cloud://env/thumb.jpg";
  assert.equal(needsVariantBackfill({
    sourceGalleryImages: [source],
    galleryImages: [display],
    galleryThumbnails: [thumbnail],
    galleryBanners: ["cloud://env/banner.jpg"],
    coverThumbnail: thumbnail,
    coverBanner: "cloud://env/banner.jpg",
    imageVariantVersion: 2,
  }), false);
  assert.equal(needsVariantBackfill({
    galleryImages: [source],
    coverImage: source,
  }), true);
  assert.equal(needsVariantBackfill({ galleryImages: [] }), false);
});

test("backfill detects aliased thumbnails, inconsistent arrays and old versions", () => {
  const source = "cloud://env/source.jpg";
  const display = "cloud://env/display.jpg";
  const banner = "cloud://env/banner.jpg";
  assert.equal(needsVariantBackfill({
    sourceGalleryImages: [source],
    galleryImages: [display],
    galleryThumbnails: [source],
    galleryBanners: [banner],
    coverThumbnail: source,
    coverBanner: banner,
    imageVariantVersion: 2,
  }), true);
  assert.equal(needsVariantBackfill({
    sourceGalleryImages: [source],
    galleryImages: [display],
    galleryThumbnails: ["cloud://env/thumb.jpg"],
    galleryBanners: [],
    coverThumbnail: "cloud://env/thumb.jpg",
    imageVariantVersion: 2,
  }), true);
  assert.equal(needsBannerBackfill({
    image: source,
    optimizedImage: banner,
    imageVariantVersion: 2,
  }), false);
  assert.equal(needsBannerBackfill({ image: source }), true);
});

test("resume skips successful cases but retries prior failures", () => {
  const candidates = ["case_1", "case_2", "case_3", "case_4"].map((_id) => ({
    _id,
  }));
  const selected = selectBackfillCandidates(
    candidates,
    { start: 1, limit: 0 },
    {
      completedCaseIds: ["case_1", "case_3"],
      failedCaseIds: ["case_2"],
    }
  );
  assert.deepEqual(
    selected.map((item) => item._id),
    ["case_2", "case_4"]
  );
});
