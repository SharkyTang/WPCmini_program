import { DEFAULT_CONFIG } from "../constants";
import type {
  AdminConfig,
  CaseDraft,
  CaseRecord,
  HomeSection,
  HomeSectionOrders,
} from "../types";
import { normalizeValues } from "./caseLogic";

function dateText(value: unknown): string {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "number") return new Date(value).toISOString();
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const candidate = record.$date ?? record.timestamp ?? record.seconds;
    if (typeof candidate === "number") {
      return new Date(candidate < 10_000_000_000 ? candidate * 1000 : candidate).toISOString();
    }
  }
  return "";
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeHomeSections(value: unknown): HomeSection[] {
  return normalizeValues(value).filter((section): section is HomeSection =>
    ["banner", "popular", "latest"].includes(section),
  );
}

function normalizeHomeOrder(value: unknown): Partial<Record<HomeSection, number>> {
  if (!value || typeof value !== "object") return {};
  const input = value as Record<string, unknown>;
  const output: Partial<Record<HomeSection, number>> = {};
  (["banner", "popular", "latest"] as HomeSection[]).forEach((section) => {
    const parsed = Number(input[section]);
    if (Number.isFinite(parsed)) output[section] = parsed;
  });
  return output;
}

export function normalizeCaseRecord(value: unknown): CaseRecord {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const id = String(raw._id || raw.id || raw.caseId || "");
  const galleryImages = normalizeValues(raw.galleryImages);
  const coverImage = String(raw.coverImage || galleryImages[0] || "");
  const rawGalleryImageUrls = Array.isArray(raw.galleryImageUrls)
    ? raw.galleryImageUrls.map((value) => String(value || ""))
    : [];
  const coverImageUrl = String(
    raw.coverImageUrl ||
      raw.coverThumbnailUrl ||
      rawGalleryImageUrls[0] ||
      (/^https?:|^data:|^blob:/.test(coverImage) ? coverImage : ""),
  );
  return {
    _id: id,
    id,
    title: String(raw.title || "未命名案例"),
    caseId: String(raw.caseId || id),
    coverImage,
    coverThumbnail: String(raw.coverThumbnail || ""),
    coverBanner: String(raw.coverBanner || ""),
    coverImageUrl,
    galleryImages: galleryImages.length ? galleryImages : [coverImage].filter(Boolean),
    sourceGalleryImages: normalizeValues(raw.sourceGalleryImages),
    galleryThumbnails: normalizeValues(raw.galleryThumbnails),
    galleryBanners: normalizeValues(raw.galleryBanners),
    galleryImageUrls: (galleryImages.length ? galleryImages : [coverImage].filter(Boolean)).map(
      (fileID, index) => {
        const candidate = rawGalleryImageUrls[index] || (index === 0 ? coverImageUrl : "");
        if (/^https?:|^data:|^blob:/.test(candidate)) return candidate;
        if (/^https?:|^data:|^blob:/.test(fileID)) return fileID;
        return "";
      },
    ),
    imageVariantVersion: numberValue(raw.imageVariantVersion, 0),
    wineType: String(raw.wineType || "白酒"),
    packageTypes: normalizeValues(raw.packageTypes),
    styles: normalizeValues(raw.styles),
    priceLevel: String(raw.priceLevel || ""),
    scenes: normalizeValues(raw.scenes),
    statuses: normalizeValues(raw.statuses),
    homeSections: normalizeHomeSections(raw.homeSections),
    homeSectionOrder: normalizeHomeOrder(raw.homeSectionOrder),
    sortOrder: numberValue(raw.sortOrder, 9999),
    notes: String(raw.notes || ""),
    isVisible: raw.isVisible === true,
    isPinned: raw.isPinned === true,
    version: Math.max(1, numberValue(raw.version, 1)),
    deletedAt: dateText(raw.deletedAt) || null,
    deletedBy: (raw.deletedBy as CaseRecord["deletedBy"]) || null,
    createdAt: dateText(raw.createdAt),
    updatedAt: dateText(raw.updatedAt),
    clientMutationId: raw.clientMutationId ? String(raw.clientMutationId) : undefined,
  };
}

export function toCasePayload(draft: Partial<CaseDraft>): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...draft };
  const multiFields = [
    "packageTypes",
    "styles",
    "scenes",
    "statuses",
    "homeSections",
  ] as const;
  multiFields.forEach((field) => {
    if (field in draft) payload[field] = { values: normalizeValues(draft[field]) };
  });
  delete payload.version;
  return payload;
}

function normalizeOrders(value: unknown): HomeSectionOrders {
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    banner: normalizeValues(input.banner),
    popular: normalizeValues(input.popular),
    latest: normalizeValues(input.latest),
  };
}

export function normalizeAdminConfig(value: unknown): AdminConfig {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const rawOptions =
    (raw.options as Record<string, unknown> | undefined) ||
    (raw.classificationOptions as Record<string, unknown> | undefined) ||
    {};
  const rawLimits = (raw.limits as Record<string, unknown> | undefined) || {};
  const rawHomepage =
    (rawLimits.homepage as Record<string, unknown> | undefined) ||
    (raw.homepageLimits as Record<string, unknown> | undefined) ||
    {};
  return {
    options: {
      wineTypes: normalizeValues(rawOptions.wineTypes).length
        ? normalizeValues(rawOptions.wineTypes)
        : DEFAULT_CONFIG.options.wineTypes,
      packageTypes: normalizeValues(rawOptions.packageTypes).length
        ? normalizeValues(rawOptions.packageTypes)
        : DEFAULT_CONFIG.options.packageTypes,
      styles: normalizeValues(rawOptions.styles).length
        ? normalizeValues(rawOptions.styles)
        : DEFAULT_CONFIG.options.styles,
      priceLevels: normalizeValues(rawOptions.priceLevels).length
        ? normalizeValues(rawOptions.priceLevels)
        : DEFAULT_CONFIG.options.priceLevels,
      scenes: normalizeValues(rawOptions.scenes).length
        ? normalizeValues(rawOptions.scenes)
        : DEFAULT_CONFIG.options.scenes,
      statuses: normalizeValues(rawOptions.statuses).length
        ? normalizeValues(rawOptions.statuses)
        : DEFAULT_CONFIG.options.statuses,
    },
    limits: {
      gallery: numberValue(rawLimits.gallery, DEFAULT_CONFIG.limits.gallery),
      batch: numberValue(rawLimits.batch, DEFAULT_CONFIG.limits.batch),
      uploadBytes: numberValue(rawLimits.uploadBytes, DEFAULT_CONFIG.limits.uploadBytes),
      homepage: {
        banner: numberValue(rawHomepage.banner, DEFAULT_CONFIG.limits.homepage.banner),
        popular: numberValue(rawHomepage.popular, DEFAULT_CONFIG.limits.homepage.popular),
        latest: numberValue(rawHomepage.latest, DEFAULT_CONFIG.limits.homepage.latest),
      },
    },
    writeEnabled: raw.writeEnabled === true,
    homeSectionOrders: normalizeOrders(raw.homeSectionOrders || raw.orders || raw.homeSectionOrder),
  };
}
