import type { AdminConfig, CaseFilters, HomeSection } from "./types";

export const BRAND = {
  ink: "#3d2d24",
  inkSoft: "#6f594c",
  gold: "#b38a4a",
  goldDark: "#8c6935",
  cream: "#f6f0e6",
  paper: "#fffdf9",
  line: "#e7dccd",
  red: "#a8493f",
};

export const HOME_SECTION_META: Record<
  HomeSection,
  { label: string; shortLabel: string; description: string }
> = {
  banner: {
    label: "首页轮播",
    shortLabel: "轮播",
    description: "首页顶部主视觉，最多 5 张",
  },
  popular: {
    label: "热门案例",
    shortLabel: "热门",
    description: "首页热门案例区域，最多 4 个",
  },
  latest: {
    label: "最新案例",
    shortLabel: "最新",
    description: "首页最新案例区域，最多 6 个",
  },
};

export const DEFAULT_CONFIG: AdminConfig = {
  options: {
    wineTypes: ["白酒"],
    packageTypes: ["整套包装", "瓶标", "瓶子", "礼盒", "桶盒", "卡盒", "手提袋", "外箱"],
    styles: ["轻奢", "国风", "新中式", "复古", "简约", "商务", "时尚", "喜庆"],
    priceLevels: ["基础款", "品质款", "高端款", "珍藏款"],
    scenes: ["婚宴", "送礼", "商务招待", "节庆礼赠", "商超陈列", "电商展示", "企业纪念"],
    statuses: ["热门产品", "最新产品"],
  },
  limits: {
    gallery: 9,
    batch: 50,
    uploadBytes: 20 * 1024 * 1024,
    homepage: {
      banner: 5,
      popular: 4,
      latest: 6,
    },
  },
  writeEnabled: true,
  homeSectionOrders: {
    banner: [],
    popular: [],
    latest: [],
  },
};

export const EMPTY_FILTERS: CaseFilters = {
  keyword: "",
  packageTypes: [],
  styles: [],
  priceLevel: [],
  scenes: [],
  statuses: [],
  homeSections: [],
  visibility: "all",
  isPinned: "all",
  trash: false,
};

export const QUEUE_STATUS_META = {
  waiting: { label: "等待上传", color: "default" },
  uploading: { label: "正在上传", color: "processing" },
  processing: { label: "图片处理中", color: "processing" },
  creating: { label: "正在建档", color: "processing" },
  needs_tags: { label: "待补标签", color: "warning" },
  done: { label: "已完成", color: "success" },
  failed: { label: "失败", color: "error" },
} as const;
