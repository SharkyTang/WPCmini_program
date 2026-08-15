import { DEFAULT_CONFIG } from "../constants";
import type { CaseRecord, HomeSection, HomeSectionOrders } from "../types";

const TITLES = [
  "山河酿·典藏礼盒",
  "金桂坊·中秋限定",
  "云岭春·青瓷系列",
  "赤霞宴·婚庆双支装",
  "禾下香·东方谷韵",
  "叁拾年·年份典藏",
  "锦官城·城市礼赠",
  "月白·极简光瓶",
  "松风渡·新中式礼盒",
  "九州同庆·节庆装",
  "墨泉·商务宴请",
  "凤凰台·高端定制",
  "竹影清风·年轻化系列",
  "丰收季·企业纪念",
  "长安序·盛唐国风",
  "问山·珍藏坛装",
  "喜相逢·婚宴用酒",
  "星河·电商新品",
  "万里茶酒·跨界礼盒",
  "岁寒三友·收藏版",
  "旧时光·复古瓶标",
  "鎏金时代·精品卡盒",
  "一见倾心·伴手礼",
  "大地红·商超陈列",
];

const PALETTES = [
  ["#5d1f1d", "#c79c52", "#efe1c7"],
  ["#173d3a", "#d0ae69", "#f4ead5"],
  ["#315069", "#d8c5a4", "#f3efe6"],
  ["#8f2e28", "#e2b468", "#f8ead8"],
  ["#6c5433", "#d2b177", "#efe6d1"],
  ["#242729", "#aa7a39", "#e6dccd"],
];

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => {
    return { "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[char] || char;
  });
}

export function wineArtwork(index: number, title: string): string {
  const [dark, gold, paper] = PALETTES[index % PALETTES.length];
  const shortTitle = escapeXml(title.slice(0, 4));
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="720" height="900" viewBox="0 0 720 900">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${paper}"/>
          <stop offset="1" stop-color="${gold}" stop-opacity=".34"/>
        </linearGradient>
        <filter id="shadow"><feDropShadow dx="0" dy="18" stdDeviation="20" flood-opacity=".18"/></filter>
      </defs>
      <rect width="720" height="900" fill="url(#bg)"/>
      <circle cx="590" cy="120" r="190" fill="${gold}" opacity=".13"/>
      <circle cx="100" cy="760" r="230" fill="${dark}" opacity=".07"/>
      <g filter="url(#shadow)">
        <rect x="122" y="175" width="245" height="535" rx="13" fill="${dark}"/>
        <rect x="142" y="196" width="205" height="493" rx="5" fill="none" stroke="${gold}" stroke-width="3"/>
        <path d="M445 315h92v80c0 18 22 34 22 66v209c0 35-21 55-68 55s-68-20-68-55V461c0-32 22-48 22-66z" fill="${dark}"/>
        <rect x="458" y="264" width="66" height="66" rx="7" fill="${gold}"/>
        <rect x="438" y="470" width="106" height="145" rx="4" fill="${paper}"/>
        <rect x="448" y="480" width="86" height="125" fill="none" stroke="${gold}" stroke-width="2"/>
      </g>
      <text x="244" y="345" fill="${gold}" font-size="30" text-anchor="middle" font-family="serif" letter-spacing="6">${shortTitle}</text>
      <line x1="188" y1="380" x2="300" y2="380" stroke="${gold}" opacity=".7"/>
      <text x="491" y="540" fill="${dark}" font-size="22" text-anchor="middle" font-family="serif">${escapeXml(title.slice(0, 3))}</text>
      <text x="54" y="68" fill="${dark}" font-size="18" font-family="sans-serif" letter-spacing="4">WINE PACKAGING / ${String(index + 1).padStart(2, "0")}</text>
      <text x="360" y="832" fill="${dark}" opacity=".68" font-size="18" text-anchor="middle" font-family="sans-serif">${escapeXml(title)}</text>
    </svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function sectionsFor(index: number): HomeSection[] {
  const sections: HomeSection[] = [];
  if (index < 5) sections.push("banner");
  if ([1, 4, 7, 10].includes(index)) sections.push("popular");
  if ([2, 5, 8, 11, 14, 17].includes(index)) sections.push("latest");
  return sections;
}

export function createMockCases(): CaseRecord[] {
  const cases = TITLES.map<CaseRecord>((title, index) => {
    const image = wineArtwork(index, title);
    const homeSections = sectionsFor(index);
    const deleted = index >= 21;
    const createdAt = new Date(Date.UTC(2026, 5, 30 - index, 8, 30)).toISOString();
    const updatedAt = new Date(Date.UTC(2026, 6, 29 - (index % 12), 8 + (index % 8), 20)).toISOString();
    return {
      _id: `mock-${String(index + 1).padStart(3, "0")}`,
      id: `mock-${String(index + 1).padStart(3, "0")}`,
      title,
      caseId: `case_${String(index + 1).padStart(3, "0")}`,
      coverImage: image,
      coverThumbnail: image,
      coverBanner: image,
      coverImageUrl: image,
      galleryImages: [image],
      sourceGalleryImages: [image],
      galleryThumbnails: [image],
      galleryBanners: [image],
      galleryImageUrls: [image],
      imageVariantVersion: 2,
      wineType: "白酒",
      packageTypes: [
        DEFAULT_CONFIG.options.packageTypes[index % DEFAULT_CONFIG.options.packageTypes.length],
        ...(index % 5 === 0 ? ["礼盒"] : []),
      ],
      styles: [DEFAULT_CONFIG.options.styles[index % DEFAULT_CONFIG.options.styles.length]],
      priceLevel: DEFAULT_CONFIG.options.priceLevels[index % DEFAULT_CONFIG.options.priceLevels.length],
      scenes: [DEFAULT_CONFIG.options.scenes[index % DEFAULT_CONFIG.options.scenes.length]],
      statuses: [
        ...(index % 4 === 0 ? ["热门产品"] : []),
        ...(index % 5 === 0 ? ["最新产品"] : []),
      ],
      homeSections,
      homeSectionOrder: {} as Partial<Record<HomeSection, number>>,
      sortOrder: index + 1,
      notes: index % 3 === 0 ? "客户偏好东方审美，需保留烫金与触感纸工艺表达。" : "",
      isVisible: !deleted && index !== 19,
      isPinned: !deleted && [0, 3, 8].includes(index),
      version: 1 + (index % 4),
      deletedAt: deleted ? new Date(Date.UTC(2026, 6, 28 - index % 3, 3)).toISOString() : null,
      deletedBy: deleted ? { type: "cloudbase_uid" as const, id: "demo-admin" } : null,
      createdAt,
      updatedAt,
    };
  });
  (["banner", "popular", "latest"] as HomeSection[]).forEach((section) => {
    cases
      .filter((item) => !item.deletedAt && item.isVisible && item.homeSections.includes(section))
      .forEach((item, index) => {
        item.homeSectionOrder[section] = index + 1;
      });
  });
  return cases;
}

export function createMockOrders(cases: CaseRecord[]): HomeSectionOrders {
  return {
    banner: cases
      .filter((item) => !item.deletedAt && item.isVisible && item.homeSections.includes("banner"))
      .sort((a, b) => (a.homeSectionOrder.banner || 999) - (b.homeSectionOrder.banner || 999))
      .map((item) => item._id),
    popular: cases
      .filter((item) => !item.deletedAt && item.isVisible && item.homeSections.includes("popular"))
      .sort((a, b) => (a.homeSectionOrder.popular || 999) - (b.homeSectionOrder.popular || 999))
      .map((item) => item._id),
    latest: cases
      .filter((item) => !item.deletedAt && item.isVisible && item.homeSections.includes("latest"))
      .sort((a, b) => (a.homeSectionOrder.latest || 999) - (b.homeSectionOrder.latest || 999))
      .map((item) => item._id),
  };
}
