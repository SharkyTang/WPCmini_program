import {
  AppstoreOutlined,
  BarsOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  MoreOutlined,
  PlusOutlined,
  PushpinFilled,
  PushpinOutlined,
  ReloadOutlined,
  SortAscendingOutlined,
  TagsOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Dropdown,
  message,
  Modal,
  Pagination,
  Segmented,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { TableColumnsType } from "antd";
import dayjs from "dayjs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { BatchTagModal, type BatchTagValues } from "../components/BatchTagModal";
import { CaseEditorDrawer } from "../components/CaseEditorDrawer";
import { CaseFiltersPanel } from "../components/CaseFiltersPanel";
import { CaseImage, CaseTagList, HomeSectionTags } from "../components/CaseVisuals";
import { PageEmpty, PageError, PageLoading, WriteDisabledAlert } from "../components/PageStates";
import { SortCasesModal } from "../components/SortCasesModal";
import { EMPTY_FILTERS } from "../constants";
import { useAdminConfig } from "../context/AdminConfigContext";
import { adminApi } from "../lib/api";
import {
  getExpectedVersions,
  hasSortableFilters,
} from "../lib/caseLogic";
import { getErrorMessage } from "../lib/errors";
import type {
  CaseFilters,
  CaseRecord,
  ListCasesResponse,
  TagField,
} from "../types";

type ViewMode = "table" | "grid";

const PAGE_SIZE_OPTIONS = [20, 40, 50];

export function CasesPage() {
  const { id: editorId } = useParams();
  const navigate = useNavigate();
  const {
    config,
    loading: configLoading,
    error: configError,
    reload: reloadConfig,
  } = useAdminConfig();
  const [filters, setFilters] = useState<CaseFilters>({ ...EMPTY_FILTERS });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [result, setResult] = useState<ListCasesResponse>({
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
    hasMore: false,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>(
    () => (localStorage.getItem("wine-admin-view-mode") as ViewMode) || "table",
  );
  const [selected, setSelected] = useState<CaseRecord[]>([]);
  const [mutating, setMutating] = useState(false);
  const [tagModalOpen, setTagModalOpen] = useState(false);
  const [sortModalOpen, setSortModalOpen] = useState(false);
  const [sortItems, setSortItems] = useState<CaseRecord[]>([]);
  const [sortLoading, setSortLoading] = useState(false);
  const [sortSaving, setSortSaving] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await adminApi.listCases({
        page,
        pageSize,
        filters,
        sort: { field: "sortOrder", direction: "asc" },
      });
      setResult(response);
      setSelected([]);
    } catch (reason) {
      setError(getErrorMessage(reason, "案例列表读取失败"));
    } finally {
      setLoading(false);
    }
  }, [filters, page, pageSize]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), filters.keyword ? 280 : 0);
    return () => window.clearTimeout(timer);
  }, [load, refreshToken, filters.keyword]);

  const refresh = () => setRefreshToken((value) => value + 1);
  const updateFilters = (next: CaseFilters) => {
    setFilters(next);
    setPage(1);
  };

  const selectedVersions = useMemo(() => getExpectedVersions(selected), [selected]);

  const runPatch = async (
    patch: Parameters<typeof adminApi.batchPatchCases>[0]["patch"],
    successText: string,
  ) => {
    if (!selected.length) return;
    setMutating(true);
    try {
      await adminApi.batchPatchCases({
        ids: selected.map((item) => item._id),
        patch,
        expectedVersions: selectedVersions,
      });
      message.success(successText);
      refresh();
    } catch (reason) {
      message.error(getErrorMessage(reason));
    } finally {
      setMutating(false);
    }
  };

  const runTagPatch = async (values: BatchTagValues) => {
    setMutating(true);
    try {
      await adminApi.batchPatchCases({
        ids: selected.map((item) => item._id),
        tags: { [values.field]: values.values } as Partial<Record<TagField, string[]>>,
        tagMode: values.mode,
        expectedVersions: selectedVersions,
      });
      setTagModalOpen(false);
      message.success(`已更新 ${selected.length} 个案例的标签`);
      refresh();
    } catch (reason) {
      message.error(getErrorMessage(reason));
    } finally {
      setMutating(false);
    }
  };

  const moveToTrash = (items: CaseRecord[]) => {
    Modal.confirm({
      title: `将 ${items.length} 个案例移入回收站？`,
      content: "案例会立即下架，并可在回收站恢复。图片不会被永久删除。",
      okText: "移入回收站",
      cancelText: "取消",
      okButtonProps: { danger: true },
      async onOk() {
        await adminApi.moveCasesToTrash(
          items.map((item) => item._id),
          getExpectedVersions(items),
        );
        message.success("已移入回收站");
        refresh();
      },
    });
  };

  const patchOne = async (
    item: CaseRecord,
    patch: Parameters<typeof adminApi.batchPatchCases>[0]["patch"],
    successText: string,
  ) => {
    try {
      await adminApi.batchPatchCases({
        ids: [item._id],
        patch,
        expectedVersions: { [item._id]: item.version },
      });
      message.success(successText);
      refresh();
    } catch (reason) {
      message.error(getErrorMessage(reason));
    }
  };

  const openSort = async () => {
    if (hasSortableFilters(filters)) {
      message.info("请先清空筛选条件，再调整全局顺序");
      return;
    }
    setSortModalOpen(true);
    setSortLoading(true);
    try {
      const all: CaseRecord[] = [];
      let currentPage = 1;
      let total = Infinity;
      while (all.length < total) {
        const response = await adminApi.listCases({
          page: currentPage,
          pageSize: 50,
          filters: { ...EMPTY_FILTERS },
          sort: { field: "sortOrder", direction: "asc" },
        });
        all.push(...response.items);
        total = response.total;
        currentPage += 1;
        if (!response.hasMore || currentPage > 200) break;
      }
      setSortItems(all);
    } catch (reason) {
      message.error(getErrorMessage(reason, "完整排序列表读取失败"));
      setSortModalOpen(false);
    } finally {
      setSortLoading(false);
    }
  };

  const saveSort = async (items: CaseRecord[]) => {
    setSortSaving(true);
    try {
      await adminApi.reorderCases(
        items.map((item) => item._id),
        getExpectedVersions(items),
      );
      message.success("全局顺序已保存");
      setSortModalOpen(false);
      refresh();
    } catch (reason) {
      message.error(getErrorMessage(reason, "顺序保存失败"));
    } finally {
      setSortSaving(false);
    }
  };

  const columns: TableColumnsType<CaseRecord> = [
    {
      title: "案例",
      key: "case",
      width: 280,
      fixed: "left",
      render: (_, item) => (
        <div className="case-title-cell">
          <CaseImage item={item} />
          <span>
            <button
              type="button"
              className="case-title-button"
              onClick={() => navigate(`/cases/${item._id}/edit`)}
            >
              {item.title}
            </button>
            <small>{item.caseId}</small>
          </span>
        </div>
      ),
    },
    {
      title: "完整标签",
      key: "tags",
      width: 310,
      render: (_, item) =>
        item.packageTypes.length ? (
          <CaseTagList item={item} />
        ) : (
          <Tag color="warning">待补标签</Tag>
        ),
    },
    {
      title: "状态",
      key: "status",
      width: 110,
      render: (_, item) => (
        <Space orientation="vertical" size={2}>
          <Badge
            status={item.isVisible ? "success" : "default"}
            text={item.isVisible ? "已上架" : "已隐藏"}
          />
          {item.isPinned ? (
            <span className="pinned-label"><PushpinFilled /> 已置顶</span>
          ) : null}
        </Space>
      ),
    },
    {
      title: "首页位置",
      dataIndex: "homeSections",
      width: 160,
      render: (sections) => <HomeSectionTags sections={sections} />,
    },
    {
      title: "排序",
      dataIndex: "sortOrder",
      width: 76,
      align: "center",
    },
    {
      title: "图片",
      key: "images",
      width: 76,
      align: "center",
      render: (_, item) => `${item.galleryImages.length} 张`,
    },
    {
      title: "更新时间",
      dataIndex: "updatedAt",
      width: 142,
      render: (value) => (
        <span className="date-cell">
          {value ? dayjs(value).format("YYYY-MM-DD") : "—"}
          <small>{value ? dayjs(value).format("HH:mm") : ""}</small>
        </span>
      ),
    },
    {
      title: "操作",
      key: "actions",
      width: 138,
      fixed: "right",
      render: (_, item) => (
        <Space size={2}>
          <Tooltip title="编辑">
            <Button
              type="text"
              icon={<EditOutlined />}
              onClick={() => navigate(`/cases/${item._id}/edit`)}
            />
          </Tooltip>
          <Dropdown
            trigger={["click"]}
            menu={{
              items: [
                {
                  key: "visibility",
                  icon: item.isVisible ? <EyeInvisibleOutlined /> : <EyeOutlined />,
                  label: item.isVisible ? "隐藏案例" : "上架案例",
                  disabled: !config.writeEnabled,
                  onClick: () =>
                    void patchOne(
                      item,
                      { isVisible: !item.isVisible },
                      item.isVisible ? "案例已隐藏" : "案例已上架",
                    ),
                },
                {
                  key: "pin",
                  icon: item.isPinned ? <PushpinOutlined /> : <PushpinFilled />,
                  label: item.isPinned ? "取消置顶" : "设为置顶",
                  disabled: !config.writeEnabled,
                  onClick: () =>
                    void patchOne(
                      item,
                      { isPinned: !item.isPinned },
                      item.isPinned ? "已取消置顶" : "案例已置顶",
                    ),
                },
                { type: "divider" },
                {
                  key: "trash",
                  danger: true,
                  icon: <DeleteOutlined />,
                  label: "移入回收站",
                  disabled: !config.writeEnabled,
                  onClick: () => moveToTrash([item]),
                },
              ],
            }}
          >
            <Button type="text" icon={<MoreOutlined />} />
          </Dropdown>
        </Space>
      ),
    },
  ];

  if (configLoading) return <PageLoading rows={6} />;
  if (configError && !loading) {
    return <PageError message={configError} onRetry={() => void reloadConfig()} />;
  }

  return (
    <div className="page-stack">
      {!config.writeEnabled ? <WriteDisabledAlert /> : null}

      <div className="page-toolbar">
        <div>
          <Typography.Text className="toolbar-count">
            共 <strong>{result.total}</strong> 个案例
          </Typography.Text>
          <Typography.Text className="secondary-text">
            支持最多 {config.limits.batch} 个案例批量操作
          </Typography.Text>
        </div>
        <Space>
          <Tooltip
            title={hasSortableFilters(filters) ? "清空筛选后可调整全局顺序" : undefined}
          >
            <Button
              icon={<SortAscendingOutlined />}
              disabled={hasSortableFilters(filters) || !config.writeEnabled}
              onClick={() => void openSort()}
            >
              调整排序
            </Button>
          </Tooltip>
          <Button icon={<UploadOutlined />} onClick={() => navigate("/cases/upload")}>
            批量上传
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => navigate("/cases/upload")}
          >
            新增案例
          </Button>
        </Space>
      </div>

      <CaseFiltersPanel
        filters={filters}
        onChange={updateFilters}
        onReset={() => updateFilters({ ...EMPTY_FILTERS })}
      />

      <div className="list-control-bar">
        <div>
          {selected.length ? (
            <Space>
              <Typography.Text>
                已选 <strong>{selected.length}</strong> 项
              </Typography.Text>
              <Dropdown
                disabled={!config.writeEnabled || mutating}
                menu={{
                  items: [
                    {
                      key: "show",
                      icon: <EyeOutlined />,
                      label: "批量上架",
                      onClick: () => void runPatch({ isVisible: true }, "所选案例已上架"),
                    },
                    {
                      key: "hide",
                      icon: <EyeInvisibleOutlined />,
                      label: "批量隐藏",
                      onClick: () => void runPatch({ isVisible: false }, "所选案例已隐藏"),
                    },
                    {
                      key: "pin",
                      icon: <PushpinFilled />,
                      label: "批量置顶",
                      onClick: () => void runPatch({ isPinned: true }, "所选案例已置顶"),
                    },
                    {
                      key: "unpin",
                      icon: <PushpinOutlined />,
                      label: "取消置顶",
                      onClick: () => void runPatch({ isPinned: false }, "已取消置顶"),
                    },
                    {
                      key: "tags",
                      icon: <TagsOutlined />,
                      label: "修改标签",
                      onClick: () => setTagModalOpen(true),
                    },
                    { type: "divider" },
                    {
                      key: "trash",
                      danger: true,
                      icon: <DeleteOutlined />,
                      label: "移入回收站",
                      onClick: () => moveToTrash(selected),
                    },
                  ],
                }}
              >
                <Button loading={mutating}>批量操作</Button>
              </Dropdown>
              <Button type="link" onClick={() => setSelected([])}>取消选择</Button>
            </Space>
          ) : (
            <Typography.Text className="secondary-text">
              勾选案例后可批量上架、改标签或移入回收站
            </Typography.Text>
          )}
        </div>
        <Space>
          <Button type="text" icon={<ReloadOutlined />} onClick={refresh}>
            刷新
          </Button>
          <Segmented<ViewMode>
            value={viewMode}
            options={[
              { value: "table", icon: <BarsOutlined />, label: "表格" },
              { value: "grid", icon: <AppstoreOutlined />, label: "图片" },
            ]}
            onChange={(value) => {
              setViewMode(value);
              localStorage.setItem("wine-admin-view-mode", value);
            }}
          />
        </Space>
      </div>

      {loading ? (
        <PageLoading />
      ) : error ? (
        <PageError message={error} onRetry={() => void load()} />
      ) : !result.items.length ? (
        <PageEmpty
          title="没有符合条件的案例"
          description="尝试调整筛选条件，或上传一批新案例。"
          action={
            <Button type="primary" onClick={() => navigate("/cases/upload")}>
              去批量上传
            </Button>
          }
        />
      ) : viewMode === "table" ? (
        <Card className="data-card" styles={{ body: { padding: 0 } }}>
          <Table<CaseRecord>
            rowKey="_id"
            columns={columns}
            dataSource={result.items}
            pagination={false}
            scroll={{ x: 1420 }}
            rowSelection={{
              selectedRowKeys: selected.map((item) => item._id),
              onChange: (_, rows) => {
                if (rows.length > config.limits.batch) {
                  message.warning(`每次最多选择 ${config.limits.batch} 个案例`);
                  return;
                }
                setSelected(rows);
              },
            }}
          />
        </Card>
      ) : (
        <div className="case-grid">
          {result.items.map((item) => {
            const checked = selected.some((selectedItem) => selectedItem._id === item._id);
            return (
              <Card
                key={item._id}
                className={`case-grid-card ${checked ? "is-selected" : ""}`}
                cover={
                  <button
                    type="button"
                    className="case-grid-image"
                    onClick={() => navigate(`/cases/${item._id}/edit`)}
                  >
                    {item.coverImageUrl ? (
                      <img
                        src={item.coverImageUrl}
                        alt={item.title}
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <span>暂无图片</span>
                    )}
                    <span className="image-count">{item.galleryImages.length} 张</span>
                  </button>
                }
                actions={[
                  <button
                    type="button"
                    className="card-action"
                    onClick={() => navigate(`/cases/${item._id}/edit`)}
                    key="edit"
                  >
                    <EditOutlined /> 编辑
                  </button>,
                  <button
                    type="button"
                    className="card-action danger"
                    disabled={!config.writeEnabled}
                    onClick={() => moveToTrash([item])}
                    key="trash"
                  >
                    <DeleteOutlined /> 回收
                  </button>,
                ]}
              >
                <Checkbox
                  className="case-card-checkbox"
                  checked={checked}
                  onChange={(event) => {
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, item].slice(0, config.limits.batch)
                        : current.filter((candidate) => candidate._id !== item._id),
                    );
                  }}
                />
                <div className="case-grid-copy">
                  <Space size={6}>
                    <Badge status={item.isVisible ? "success" : "default"} />
                    <Typography.Text className="case-id">{item.caseId}</Typography.Text>
                    {item.isPinned ? <PushpinFilled className="pin-icon" /> : null}
                  </Space>
                  <Typography.Title level={5}>{item.title}</Typography.Title>
                  {item.packageTypes.length ? (
                    <CaseTagList item={item} limit={3} />
                  ) : (
                    <Tag color="warning">待补标签</Tag>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {!loading && result.total > 0 ? (
        <div className="pagination-row">
          <Pagination
            current={page}
            pageSize={pageSize}
            total={result.total}
            showSizeChanger
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            showTotal={(total, range) => `第 ${range[0]}–${range[1]} 条，共 ${total} 条`}
            onChange={(nextPage, nextSize) => {
              setPage(nextSize !== pageSize ? 1 : nextPage);
              setPageSize(nextSize);
            }}
          />
        </div>
      ) : null}

      <BatchTagModal
        open={tagModalOpen}
        count={selected.length}
        loading={mutating}
        onCancel={() => setTagModalOpen(false)}
        onSubmit={(values) => void runTagPatch(values)}
      />
      <SortCasesModal
        open={sortModalOpen}
        items={sortItems}
        loading={sortLoading}
        saving={sortSaving}
        onCancel={() => setSortModalOpen(false)}
        onSave={(items) => void saveSort(items)}
      />
      {editorId ? (
        <CaseEditorDrawer
          id={editorId}
          onClose={() => navigate("/cases")}
          onSaved={(updated) => {
            setResult((current) => ({
              ...current,
              items: current.items.map((item) => (item._id === updated._id ? updated : item)),
            }));
          }}
        />
      ) : null}
    </div>
  );
}
