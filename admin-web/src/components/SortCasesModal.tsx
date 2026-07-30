import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  HolderOutlined,
  SaveOutlined,
} from "@ant-design/icons";
import { Button, Modal, Space, Typography } from "antd";
import { useEffect, useState } from "react";
import { moveItem } from "../lib/caseLogic";
import type { CaseRecord } from "../types";
import { CaseImage } from "./CaseVisuals";

export function SortCasesModal({
  open,
  items,
  loading,
  saving,
  onCancel,
  onSave,
}: {
  open: boolean;
  items: CaseRecord[];
  loading: boolean;
  saving: boolean;
  onCancel: () => void;
  onSave: (items: CaseRecord[]) => void;
}) {
  const [ordered, setOrdered] = useState(items);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  useEffect(() => {
    if (open) setOrdered(items);
  }, [items, open]);

  const move = (from: number, to: number) => {
    setOrdered((current) => moveItem(current, from, to));
  };

  return (
    <Modal
      open={open}
      width={760}
      title="调整案例全局顺序"
      onCancel={onCancel}
      footer={
        <Space>
          <Button onClick={onCancel}>取消</Button>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            loading={saving}
            disabled={loading || !ordered.length}
            onClick={() => onSave(ordered)}
          >
            保存顺序
          </Button>
        </Space>
      }
      className="sort-modal"
    >
      <Typography.Paragraph className="secondary-text">
        拖拽案例调整顺序，也可以使用右侧箭头微调。保存后会同步到小程序的默认列表排序。
      </Typography.Paragraph>
      <div className="sort-list" aria-busy={loading}>
        {ordered.map((item, index) => (
          <div
            key={item._id}
            draggable
            className={`sort-list-item ${dragIndex === index ? "is-dragging" : ""}`}
            onDragStart={() => setDragIndex(index)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              if (dragIndex !== null) move(dragIndex, index);
              setDragIndex(null);
            }}
            onDragEnd={() => setDragIndex(null)}
          >
            <HolderOutlined className="drag-handle" />
            <span className="sort-number">{index + 1}</span>
            <CaseImage item={item} size={48} />
            <span className="sort-case-copy">
              <strong>{item.title}</strong>
              <small>{item.caseId}</small>
            </span>
            <Space size={4}>
              <Button
                type="text"
                icon={<ArrowUpOutlined />}
                disabled={index === 0}
                aria-label="上移"
                onClick={() => move(index, index - 1)}
              />
              <Button
                type="text"
                icon={<ArrowDownOutlined />}
                disabled={index === ordered.length - 1}
                aria-label="下移"
                onClick={() => move(index, index + 1)}
              />
            </Space>
          </div>
        ))}
      </div>
    </Modal>
  );
}
