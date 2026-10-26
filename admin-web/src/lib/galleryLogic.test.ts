import { describe, expect, it } from "vitest";
import { appendUploadedGallery } from "./galleryLogic";

describe("appendUploadedGallery", () => {
  it("appends every generated variant exactly once and keeps arrays aligned", () => {
    const next = appendUploadedGallery(
      {
        galleryImages: ["display-existing"],
        sourceGalleryImages: ["source-existing"],
        galleryThumbnails: ["thumb-existing"],
        galleryBanners: ["banner-existing"],
        galleryImageUrls: ["https://example.test/existing.jpg"],
      },
      {
        sources: ["source-new"],
        variants: [
          {
            sourceFileID: "source-new",
            displayFileID: "display-new",
            thumbnailFileID: "thumb-new",
            bannerFileID: "banner-new",
          },
        ],
      },
      ["blob:new"],
    );

    expect(next.galleryThumbnails).toEqual(["thumb-existing", "thumb-new"]);
    expect(
      [
        next.galleryImages,
        next.sourceGalleryImages,
        next.galleryThumbnails,
        next.galleryBanners,
        next.galleryImageUrls,
      ].map((values) => values.length),
    ).toEqual([2, 2, 2, 2, 2]);
  });
});
