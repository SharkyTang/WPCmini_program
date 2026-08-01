import { PictureOutlined } from "@ant-design/icons";
import { Image, Tag, Tooltip } from "antd";
import { HOME_SECTION_META } from "../constants";
import type { CaseRecord, HomeSection } from "../types";

export function CaseImage({
  item,
  size = 62,
}: {
  item: Pick<CaseRecord, "coverImageUrl" | "title">;
  size?: number;
}) {
  if (!item.coverImageUrl) {
    return (
      <div className="case-image-placeholder" style={{ width: size, height: size }}>
        <PictureOutlined />
      </div>
    );
  }
  return (
    <Image
      className="case-cover-image"
      width={size}
      height={size}
      src={item.coverImageUrl}
      alt={item.title}
      loading="lazy"
      decoding="async"
      preview={{ mask: "预览" }}
      fallback=""
    />
  );
}

export function CaseTagList({
  item,
  limit = 5,
}: {
  item: Pick<CaseRecord, "packageTypes" | "styles" | "priceLevel" | "scenes" | "statuses">;
  limit?: number;
}) {
  const values = [
    ...item.packageTypes,
    ...item.styles,
    item.priceLevel,
    ...item.scenes,
    ...item.statuses,
  ].filter(Boolean);
  const visible = values.slice(0, limit);
  return (
    <div className="case-tag-list">
      {visible.map((value, index) => (
        <Tag key={`${value}-${index}`} color={item.statuses.includes(value) ? "gold" : undefined}>
          {value}
        </Tag>
      ))}
      {values.length > limit ? (
        <Tooltip title={values.slice(limit).join("、")}>
          <Tag>+{values.length - limit}</Tag>
        </Tooltip>
      ) : null}
    </div>
  );
}

export function HomeSectionTags({ sections }: { sections: HomeSection[] }) {
  if (!sections.length) return <span className="secondary-text">未编排</span>;
  return (
    <div className="case-tag-list">
      {sections.map((section) => (
        <Tag key={section} className={`home-tag home-tag-${section}`}>
          {HOME_SECTION_META[section].shortLabel}
        </Tag>
      ))}
    </div>
  );
}
