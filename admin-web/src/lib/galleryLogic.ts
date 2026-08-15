import type { UploadedCaseImages } from "../types";

export interface GalleryState {
  galleryImages: string[];
  sourceGalleryImages: string[];
  galleryThumbnails: string[];
  galleryBanners: string[];
  galleryImageUrls: string[];
}

function align(values: string[], length: number, fallback: string[] = []): string[] {
  return Array.from({ length }, (_, index) => values[index] || fallback[index] || "");
}

export function appendUploadedGallery(
  current: GalleryState,
  upload: UploadedCaseImages,
  localUrls: string[],
): GalleryState {
  const currentLength = current.galleryImages.length;
  return {
    galleryImages: [
      ...current.galleryImages,
      ...upload.variants.map((variant) => variant.displayFileID),
    ],
    sourceGalleryImages: [
      ...align(current.sourceGalleryImages, currentLength),
      ...upload.sources,
    ],
    galleryThumbnails: [
      ...align(current.galleryThumbnails, currentLength),
      ...upload.variants.map((variant) => variant.thumbnailFileID),
    ],
    galleryBanners: [
      ...align(current.galleryBanners, currentLength),
      ...upload.variants.map((variant) => variant.bannerFileID),
    ],
    galleryImageUrls: [...current.galleryImageUrls, ...localUrls],
  };
}
