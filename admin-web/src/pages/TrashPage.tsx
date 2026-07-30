import {
  DeleteOutlined,
  InfoCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
  UndoOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Input,
  message,
  Modal,
  Pagination,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import type { TableColumnsType } from "antd";
import dayjs from "dayjs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CaseImage, CaseTagList } from "../components/CaseVisuals";
import { PageEmpty, PageError, PageLoading, WriteDisabledAlert } from "../components/PageStates";
import { EMPTY_FILTERS } from "../constants";
import { useAdminConfig } from "../context/AdminConfigContext";
import { adminApi } from "../lib/api";
import { getExpectedVersions } from "../lib/caseLogic";
import { getErrorMessage } from "../lib/errors";
import type { CaseRecord, ListCasesResponse } from "../types";

export function TrashPage() {
  const { config, loading: configLoading } = useAdminConfig();
  const [keyword, setKeyword] = useState("");
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
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<CaseRecord[]>([]);
  const [refreshToken, setRefreshToken] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await adminApi.listCases({
        page,
        pageSize,
        filters: { ...EMPTY_FILTERS, keyword, trash: true },
        sort: { field: "updatedAt", direction: "desc" },
      });
      setResult(response);
      setSelected([]);
    } catch (reason) {
      setError(getErrorMessage(reason, "回收站读取失败"));
    } finally {
      setLoading(false);
    }
  }, [keyword, page, pageSize]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), keyword ? 260 : 0);
    return () => window.clearTimeout(timer);
  }, [load, refreshToken, keyword]);

  const versions = useMemo(() => getExpectedVersions(selected), [selected]);

  const restore = (items: CaseRecord[]) => {
    Modal.confirm({
      title: `恢复 ${items.length} 个案例？`,
      content: "恢复后的案例保持隐藏，不会立即出现在小程序前台。补充检查后可在案例库中上架。",
      okText: "恢复案例",
      cancelText: "取消",
      async onOk() {
        setRestoring(true);
        try {
          await adminApi.restoreCases(
            items.map((item) => item._id),
            getExpectedVersions(items),
          );
          message.success(`已恢复 ${items.length} 个案例`);
          setRefreshToken((value) => value + 1);
        } catch (reason) {
          message.error(getErrorMessage(reason, "恢复失败"));
        } finally {
          setRestoring(false);
        }
      },
    });
  };

  const columns: TableColumnsType<CaseRecord> = [
    {
      title: "案例",
      key: "case",
      width: 340,
      render: (_, item) => (
        <div className="case-title-cell">
          <CaseImage item={item} />
          <span>
            <strong>{item.title}</strong>
            <small>{item.caseId}</small>
          </span>
        </div>
      ),
    },
    {
      title: "标签",
      key: "tags",
      render: (_, item) =>
        item.packageTypes.length ? <CaseTagList item={item} limit={4} /> : <Tag>未分类</Tag>,
    },
    {
      title: "移入时间",
      dataIndex: "deletedAt",
      width: 180,
      render: (value) => (value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "—"),
    },
    {
      title: "移入账号",
      key: "actor",
      width: 180,
      render: (_, item) => item.deletedBy?.id || "历史操作",
    },
    {
      title: "状态",
      width: 110,
      render: () => <Tag color="default">已下架</Tag>,
    },
    {
      title: "操作",
      key: "action",
      width: 120,
      fixed: "right",
      render: (_, item) => (
        <Button
          type="link"
          icon={<UndoOutlined />}
          disabled={!config.writeEnabled}
          onClick={() => restore([item])}
        >
          恢复
        </Button>
      ),
    },
  ];

  if (configLoading) return <PageLoading rows={5} />;

  return (
    <div className="page-stack">
      {!config.writeEnabled ? <WriteDisabledAlert /> : null}
      <Alert
        type="info"
        showIcon
        icon={<InfoCircleOutlined />}
        title="回收站不会永久删除图片"
        description="首版不提供永久清除。恢复后案例仍为隐藏状态，避免未经检查直接回到前台。"
      />

      <div className="page-toolbar">
        <div>
          <Typography.Text className="toolbar-count">
            回收站中 <strong>{result.total}</strong> 个案例
          </Typography.Text>
          <Typography.Text className="secondary-text">
            所有回收操作可逆，原案例编号与标签保持不变
          </Typography.Text>
        </div>
        <Space>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => setRefreshToken((value) => value + 1)}
          >
            刷新
          </Button>
          <Button
            type="primary"
            icon={<UndoOutlined />}
            loading={restoring}
            disabled={!selected.length || !config.writeEnabled}
            onClick={() => restore(selected)}
          >
            恢复已选（{selected.length}）
          </Button>
        </Space>
      </div>

      <Card className="trash-search-card">
        <Input
          allowClear
          prefix={<SearchOutlined />}
          value={keyword}
          placeholder="搜索已回收案例的标题、编号或标签"
          onChange={(event) => {
            setKeyword(event.target.value);
            setPage(1);
          }}
        />
      </Card>

      {loading ? (
        <PageLoading />
      ) : error ? (
        <PageError message={error} onRetry={() => void load()} />
      ) : !result.items.length ? (
        <PageEmpty
          title={keyword ? "没有匹配的已回收案例" : "回收站是空的"}
          description={keyword ? "换一个关键词再试试。" : "从案例库移入回收站的案例会显示在这里。"}
        />
      ) : (
        <Card className="data-card" styles={{ body: { padding: 0 } }}>
          <Table<CaseRecord>
            rowKey="_id"
            columns={columns}
            dataSource={result.items}
            pagination={false}
            scroll={{ x: 1100 }}
            rowSelection={{
              selectedRowKeys: selected.map((item) => item._id),
              onChange: (_, rows) => {
                if (rows.length > config.limits.batch) {
                  message.warning(`每次最多恢复 ${config.limits.batch} 个案例`);
                  return;
                }
                setSelected(rows);
              },
            }}
          />
        </Card>
      )}

      {!loading && result.total ? (
        <div className="pagination-row">
          <Pagination
            current={page}
            pageSize={pageSize}
            total={result.total}
            showSizeChanger
            pageSizeOptions={[20, 40, 50]}
            showTotal={(total, range) => `第 ${range[0]}–${range[1]} 条，共 ${total} 条`}
            onChange={(nextPage, nextSize) => {
              setPage(nextSize === pageSize ? nextPage : 1);
              setPageSize(nextSize);
            }}
          />
        </div>
      ) : null}

      <div className="trash-no-delete">
        <DeleteOutlined />
        <span>为避免误操作，本版本不提供永久清空。</span>
      </div>
    </div>
  );
}
