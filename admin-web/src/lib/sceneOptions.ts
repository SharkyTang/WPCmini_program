export const SCENE_VALUES = [
  "婚宴",
  "百日/满月",
  "生日宴",
  "寿宴",
  "乔迁宴",
  "送礼",
  "商务招待",
  "节庆礼赠",
  "企业纪念",
  "商超陈列",
  "电商展示",
] as const;

const SCENE_VALUE_SET = new Set<string>(SCENE_VALUES);

const SCENE_LABELS: Readonly<Record<string, string>> = {
  "婚宴": "婚宴/喜宴",
};

export function getSceneLabel(value: string): string {
  return SCENE_LABELS[value] || value;
}
export function getSceneOptions(values: readonly string[] = SCENE_VALUES) {
  return values.map((value) => ({ value, label: getSceneLabel(value) }));
}

export function normalizeSceneOptions(values: readonly string[]): string[] {
  const customValues = values
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, all) => !SCENE_VALUE_SET.has(value) && all.indexOf(value) === index);
  return [...SCENE_VALUES, ...customValues];
}
