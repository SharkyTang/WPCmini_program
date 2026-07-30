import type {
  CaseFilters,
  CaseRecord,
  HomeSection,
  TagField,
  TagMode,
} from "../types";

export function normalizeValues(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { values?: unknown }).values)
      ? (value as { values: unknown[] }).values
      : typeof value === "string"
        ? [value]
        : [];
  return [...new Set(raw.map((item) => String(item ?? "").trim()).filter(Boolean))];
}

export function valuesObject(values: string[]) {
  return { values: normalizeValues(values) };
}

export function mergeTagValues(current: string[], incoming: string[], mode: TagMode): string[] {
  const cleanCurrent = normalizeValues(current);
  const cleanIncoming = normalizeValues(incoming);
  if (mode === "replace") return cleanIncoming;
  if (mode === "remove") {
    const removed = new Set(cleanIncoming);
    return cleanCurrent.filter((value) => !removed.has(value));
  }
  return normalizeValues([...cleanCurrent, ...cleanIncoming]);
}

export function countActiveFilters(filters: CaseFilters): number {
  return (
    Number(Boolean(filters.keyword.trim())) +
    filters.packageTypes.length +
    filters.styles.length +
    filters.priceLevel.length +
    filters.scenes.length +
    filters.statuses.length +
    filters.homeSections.length +
    Number(filters.visibility !== "all") +
    Number(filters.isPinned !== "all")
  );
}

export function hasSortableFilters(filters: CaseFilters): boolean {
  return countActiveFilters(filters) > 0 || filters.trash;
}

export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return items.slice();
  }
  const next = items.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function canAddGalleryImages(
  writeEnabled: boolean,
  imageCount: number,
  limit: number,
  uploading: boolean,
  legacyVariantsIncomplete: boolean,
): boolean {
  return (
    writeEnabled &&
    imageCount < limit &&
    !uploading &&
    !legacyVariantsIncomplete
  );
}

export function buildStoragePath(
  uid: string,
  batchId: string,
  fileName: string,
  index: number,
): string {
  if (!uid.trim()) throw new Error("缺少管理员 UID，无法生成上传路径");
  const safeUid = encodeURIComponent(uid.trim());
  const safeBatch = batchId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "batch";
  const extension = (fileName.match(/\.(jpe?g|png|webp)$/i)?.[0] || ".jpg").toLowerCase();
  const baseName =
    fileName
      .replace(/\.(jpe?g|png|webp)$/i, "")
      .normalize("NFKC")
      .replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "image";
  return `wine-packaging/admin-web/${safeUid}/${safeBatch}/${String(index + 1).padStart(2, "0")}-${baseName}${extension}`;
}

export function isSupportedImage(file: File, maxBytes = 20 * 1024 * 1024): string | null {
  if (!/^image\/(jpeg|png|webp)$/i.test(file.type) && !/\.(jpe?g|png|webp)$/i.test(file.name)) {
    return "仅支持 JPEG、PNG 或 WebP 图片";
  }
  if (file.size > maxBytes) return "单张图片不能超过 20MB";
  return null;
}

export function getExpectedVersions(items: CaseRecord[]): Record<string, number> {
  return items.reduce<Record<string, number>>((versions, item) => {
    versions[item._id] = item.version;
    return versions;
  }, {});
}

export function toggleHomeSection(
  sections: HomeSection[],
  section: HomeSection,
  enabled: boolean,
): HomeSection[] {
  if (enabled) return [...new Set([...sections, section])];
  return sections.filter((value) => value !== section);
}

export function tagFieldLabel(field: TagField): string {
  return {
    packageTypes: "包装",
    styles: "风格",
    priceLevel: "价位",
    scenes: "场景",
    statuses: "运营标签",
  }[field];
}
