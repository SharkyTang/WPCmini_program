import { FilterOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { Badge, Button, Input, Select, Space } from "antd";
import { HOME_SECTION_META } from "../constants";
import { useAdminConfig } from "../context/AdminConfigContext";
import { countActiveFilters } from "../lib/caseLogic";
import { getSceneOptions } from "../lib/sceneOptions";
import type { CaseFilters, HomeSection } from "../types";

export function CaseFiltersPanel({
  filters,
  onChange,
  onReset,
}: {
  filters: CaseFilters;
  onChange: (next: CaseFilters) => void;
  onReset: () => void;
}) {
  const { config } = useAdminConfig();
  const activeCount = countActiveFilters(filters);
  const update = <K extends keyof CaseFilters>(key: K, value: CaseFilters[K]) => {
    onChange({ ...filters, [key]: value });
  };

  return (
    <div className="filter-panel">
      <div className="filter-row filter-row-primary">
        <Input
          allowClear
          value={filters.keyword}
          prefix={<SearchOutlined />}
          placeholder="搜索标题、编号、标签或备注"
          onChange={(event) => update("keyword", event.target.value)}
          className="filter-keyword"
        />
        <Select
          mode="multiple"
          maxTagCount="responsive"
          allowClear
          value={filters.packageTypes}
          placeholder="包装"
          options={config.options.packageTypes.map((value) => ({ value, label: value }))}
          onChange={(value) => update("packageTypes", value)}
        />
        <Select
          mode="multiple"
          maxTagCount="responsive"
          allowClear
          value={filters.styles}
          placeholder="风格"
          options={config.options.styles.map((value) => ({ value, label: value }))}
          onChange={(value) => update("styles", value)}
        />
        <Select
          mode="multiple"
          maxTagCount="responsive"
          allowClear
          value={filters.priceLevel}
          placeholder="价位"
          options={config.options.priceLevels.map((value) => ({ value, label: value }))}
          onChange={(value) => update("priceLevel", value)}
        />
      </div>

      <div className="filter-row filter-row-secondary">
        <span className="filter-label">
          <Badge count={activeCount} size="small" offset={[6, -3]}>
            <FilterOutlined />
          </Badge>
          复合筛选
        </span>
        <Select
          mode="multiple"
          maxTagCount={1}
          allowClear
          aria-label="场景筛选"
          value={filters.scenes}
          placeholder="场景"
          options={getSceneOptions(config.options.scenes)}
          onChange={(value) => update("scenes", value)}
        />
        <Select
          mode="multiple"
          maxTagCount={1}
          allowClear
          value={filters.statuses}
          placeholder="运营标签"
          options={config.options.statuses.map((value) => ({ value, label: value }))}
          onChange={(value) => update("statuses", value)}
        />
        <Select
          mode="multiple"
          maxTagCount={1}
          allowClear
          value={filters.homeSections}
          placeholder="首页位置"
          options={(Object.keys(HOME_SECTION_META) as HomeSection[]).map((value) => ({
            value,
            label: HOME_SECTION_META[value].label,
          }))}
          onChange={(value) => update("homeSections", value)}
        />
        <Select
          value={filters.visibility}
          options={[
            { value: "all", label: "全部显隐" },
            { value: "visible", label: "已上架" },
            { value: "hidden", label: "已隐藏" },
          ]}
          onChange={(value) => update("visibility", value)}
        />
        <Select
          value={filters.isPinned}
          options={[
            { value: "all", label: "全部置顶" },
            { value: "pinned", label: "已置顶" },
            { value: "unpinned", label: "未置顶" },
          ]}
          onChange={(value) => update("isPinned", value)}
        />
        <Space className="filter-actions">
          <Button
            icon={<ReloadOutlined />}
            disabled={!activeCount}
            onClick={onReset}
          >
            重置
          </Button>
        </Space>
      </div>
    </div>
  );
}
