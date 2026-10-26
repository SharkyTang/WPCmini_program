import {
  DeleteOutlined,
  EyeOutlined,
  HolderOutlined,
  InfoCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  message,
  Modal,
  Progress,
  Select,
  Space,
  Tag,
  Typography,
} from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBlocker } from "react-router-dom";
import { CaseImage } from "../components/CaseVisuals";
import { OrderMoveButtons } from "../components/OrderMoveButtons";
import { PageError, PageLoading, WriteDisabledAlert } from "../components/PageStates";
import { EMPTY_FILTERS, HOME_SECTION_META } from "../constants";
import { useAdminConfig } from "../context/AdminConfigContext";
import { adminApi } from "../lib/api";
import { getExpectedVersions, moveItem } from "../lib/caseLogic";
import { getErrorMessage } from "../lib/errors";
import type { CaseRecord, HomeSection, HomeSectionOrders } from "../types";

const SECTIONS: HomeSection[] = ["banner", "popular", "latest"];

function emptyOrders(): HomeSectionOrders {
  return { banner: [], popular: [], latest: [] };
}

export function HomepagePage() {
  const { config, loading: configLoading, reload: reloadConfig } = useAdminConfig();
  const [cases, setCases] = useState<CaseRecord[]>([]);
  const [orders, setOrders] = useState<HomeSectionOrders>(emptyOrders);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [dragging, setDragging] = useState<{ section: HomeSection; index: number } | null>(null);
  const [addSection, setAddSection] = useState<HomeSection | null>(null);
  const [candidateId, setCandidateId] = useState("");
  const blockerDialogOpenRef = useRef(false);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [latestConfig, first] = await Promise.all([
        adminApi.getAdminConfig(),
        adminApi.listCases({
          page: 1,
          pageSize: 50,
          filters: { ...EMPTY_FILTERS },
          sort: { field: "sortOrder", direction: "asc" },
        }),
      ]);
      const all = [...first.items];
      let page = 2;
      while (all.length < first.total && page <= 200) {
        const next = await adminApi.listCases({
          page,
          pageSize: 50,
          filters: { ...EMPTY_FILTERS },
          sort: { field: "sortOrder", direction: "asc" },
        });
        all.push(...next.items);
        if (!next.hasMore) break;
        page += 1;
      }
      const byId = new Map(all.map((item) => [item._id, item]));
      const nextOrders = emptyOrders();
      SECTIONS.forEach((section) => {
        const configured = latestConfig.homeSectionOrders[section].filter(
          (id) => byId.get(id)?.isVisible,
        );
        const fallback = all
          .filter(
            (item) =>
              item.isVisible &&
              item.homeSections.includes(section) &&
              !configured.includes(item._id),
          )
          .sort(
            (left, right) =>
              (left.homeSectionOrder[section] || left.sortOrder) -
              (right.homeSectionOrder[section] || right.sortOrder),
          )
          .map((item) => item._id);
        nextOrders[section] = [...configured, ...fallback].slice(
          0,
          latestConfig.limits.homepage[section],
        );
      });
      setCases(all);
      setOrders(nextOrders);
      setDirty(false);
      await reloadConfig();
    } catch (reason) {
      setError(getErrorMessage(reason, "首页编排读取失败"));
    } finally {
      setLoading(false);
    }
  }, [reloadConfig]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    if (blocker.state !== "blocked" || blockerDialogOpenRef.current) return;
    blockerDialogOpenRef.current = true;
    Modal.confirm({
      title: "离开并放弃未保存的首页编排？",
      content: "三个首页区域还有未保存的顺序或成员调整。",
      okText: "放弃并离开",
      cancelText: "继续编排",
      okButtonProps: { danger: true },
      onOk: () => blocker.proceed(),
      onCancel: () => blocker.reset(),
      afterClose: () => {
        blockerDialogOpenRef.current = false;
      },
    });
  }, [blocker]);

  const caseMap = useMemo(
    () => new Map(cases.map((item) => [item._id, item])),
    [cases],
  );

  const reorder = (section: HomeSection, from: number, to: number) => {
    setOrders((current) => ({
      ...current,
      [section]: moveItem(current[section], from, to),
    }));
    setDirty(true);
  };

  const remove = (section: HomeSection, id: string) => {
    setOrders((current) => ({
      ...current,
      [section]: current[section].filter((itemId) => itemId !== id),
    }));
    setDirty(true);
  };

  const addCandidate = () => {
    if (!addSection || !candidateId) return;
    if (orders[addSection].length >= config.limits.homepage[addSection]) {
      message.error(`${HOME_SECTION_META[addSection].label}已达到容量上限`);
      return;
    }
    setOrders((current) => ({
      ...current,
      [addSection]: [...current[addSection], candidateId],
    }));
    setDirty(true);
    setAddSection(null);
    setCandidateId("");
  };

  const save = async () => {
    setSaving(true);
    try {
      await adminApi.setHomeSectionOrder(orders, getExpectedVersions(cases));
      setDirty(false);
      await load();
      message.success("首页三个区域已原子保存");
    } catch (reason) {
      message.error(getErrorMessage(reason, "首页编排保存失败"));
    } finally {
      setSaving(false);
    }
  };

  if (loading || configLoading) return <PageLoading rows={4} />;
  if (error) return <PageError message={error} onRetry={() => void load()} />;

  return (
    <div className="page-stack">
      {!config.writeEnabled ? <WriteDisabledAlert /> : null}
      <Alert
        type="info"
        showIcon
        icon={<InfoCircleOutlined />}
        title="首页位置与运营标签相互独立"
        description="“热门产品 / 最新产品”仅用于运营筛选，不会自动决定首页位置。这里保存的顺序才是首页最终展示顺序。"
      />

      <div className="page-toolbar homepage-toolbar">
        <div>
          <Typography.Text className="toolbar-count">
            首页编排 <strong>{dirty ? "有未保存修改" : "已同步"}</strong>
          </Typography.Text>
          <Typography.Text className="secondary-text">
            三个区域会在一次操作中同时保存，避免前台出现中间状态
          </Typography.Text>
        </div>
        <Space>
          <Button
            icon={<ReloadOutlined />}
            disabled={saving}
            onClick={() => {
              if (!dirty) {
                void load();
                return;
              }
              Modal.confirm({
                title: "放弃未保存的编排？",
                content: "重新加载会还原为云端当前顺序。",
                okText: "放弃并加载",
                cancelText: "继续编辑",
                okButtonProps: { danger: true },
                onOk: () => void load(),
              });
            }}
          >
            重新加载
          </Button>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            loading={saving}
            disabled={!dirty || !config.writeEnabled}
            onClick={() => void save()}
          >
            保存全部编排
          </Button>
        </Space>
      </div>

      <div className="homepage-columns">
        {SECTIONS.map((section) => {
          const meta = HOME_SECTION_META[section];
          const limit = config.limits.homepage[section];
          const ids = orders[section];
          return (
            <Card
              key={section}
              className={`homepage-section-card homepage-${section}`}
              title={
                <span className="homepage-section-title">
                  <span className="section-index">
                    {section === "banner" ? "01" : section === "popular" ? "02" : "03"}
                  </span>
                  <span>
                    <strong>{meta.label}</strong>
                    <small>{meta.description}</small>
                  </span>
                </span>
              }
              extra={
                <Button
                  size="small"
                  type="text"
                  icon={<EyeOutlined />}
                  onClick={() => message.info("保存后可在微信小程序首页查看实际效果")}
                >
                  预览说明
                </Button>
              }
            >
              <div className="section-capacity">
                <Progress
                  percent={(ids.length / limit) * 100}
                  showInfo={false}
                  strokeColor={ids.length === limit ? "#b38a4a" : "#6e7b63"}
                  size="small"
                />
                <span>{ids.length} / {limit}</span>
              </div>

              <div className="homepage-sort-list">
                {ids.map((id, index) => {
                  const item = caseMap.get(id);
                  if (!item) return null;
                  return (
                    <div
                      key={id}
                      draggable={config.writeEnabled}
                      className={`homepage-sort-item ${
                        dragging?.section === section && dragging.index === index
                          ? "is-dragging"
                          : ""
                      }`}
                      onDragStart={() => setDragging({ section, index })}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={() => {
                        if (dragging?.section === section) {
                          reorder(section, dragging.index, index);
                        }
                        setDragging(null);
                      }}
                      onDragEnd={() => setDragging(null)}
                    >
                      <HolderOutlined className="drag-handle" />
                      <span className="home-position">{index + 1}</span>
                      <CaseImage item={item} size={52} />
                      <span className="home-case-copy">
                        <strong>{item.title}</strong>
                        <small>{item.caseId}</small>
                      </span>
                      <OrderMoveButtons
                        index={index}
                        total={ids.length}
                        ariaContext={`${meta.label}中的案例“${item.title}”`}
                        disabled={!config.writeEnabled}
                        onMove={(to) => reorder(section, index, to)}
                      />
                      <Button
                        type="text"
                        danger
                        icon={<DeleteOutlined />}
                        disabled={!config.writeEnabled}
                        aria-label={`从${meta.label}移除案例“${item.title}”`}
                        onClick={() => remove(section, id)}
                      />
                    </div>
                  );
                })}
                {!ids.length ? (
                  <div className="homepage-slot-empty">
                    <span>还没有案例</span>
                    <small>添加后可拖拽或使用上移、下移按钮调整顺序</small>
                  </div>
                ) : null}
              </div>

              <Button
                block
                type="dashed"
                icon={<PlusOutlined />}
                disabled={ids.length >= limit || !config.writeEnabled}
                onClick={() => {
                  setAddSection(section);
                  setCandidateId("");
                }}
              >
                添加已上架案例
              </Button>
            </Card>
          );
        })}
      </div>

      <div className="homepage-footnote">
        <Tag color="gold">拖拽 / 键盘排序</Tag>
        <span>首页三个区域分别排序；也可用每项的上移、下移按钮操作。</span>
      </div>

      <Modal
        open={Boolean(addSection)}
        title={addSection ? `添加到${HOME_SECTION_META[addSection].label}` : "添加案例"}
        okText="添加"
        cancelText="取消"
        okButtonProps={{ disabled: !candidateId }}
        onOk={addCandidate}
        onCancel={() => setAddSection(null)}
      >
        <Typography.Paragraph className="secondary-text">
          仅显示已上架案例；同一案例可以出现在不同首页区域。
        </Typography.Paragraph>
        <Select
          showSearch
          value={candidateId || undefined}
          placeholder="按标题或编号搜索"
          optionFilterProp="label"
          className="full-width"
          options={cases
            .filter(
              (item) =>
                item.isVisible &&
                (!addSection || !orders[addSection].includes(item._id)),
            )
            .map((item) => ({
              value: item._id,
              label: `${item.title} · ${item.caseId}`,
            }))}
          onChange={setCandidateId}
        />
      </Modal>
    </div>
  );
}
