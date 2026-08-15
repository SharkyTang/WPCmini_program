import { Form, Modal, Radio, Select, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useAdminConfig } from "../context/AdminConfigContext";
import { tagFieldLabel } from "../lib/caseLogic";
import { getSceneOptions } from "../lib/sceneOptions";
import type { TagField, TagMode } from "../types";

interface BatchTagValues {
  field: TagField;
  mode: TagMode;
  values: string[];
}

export function BatchTagModal({
  open,
  count,
  loading,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  count: number;
  loading: boolean;
  onCancel: () => void;
  onSubmit: (values: BatchTagValues) => void;
}) {
  const [form] = Form.useForm<BatchTagValues>();
  const { config } = useAdminConfig();
  const [field, setField] = useState<TagField>("packageTypes");
  const options = useMemo(() => {
    const values = ({
      packageTypes: config.options.packageTypes,
      styles: config.options.styles,
      priceLevel: config.options.priceLevels,
      scenes: config.options.scenes,
      statuses: config.options.statuses,
    })[field];
    return field === "scenes"
      ? getSceneOptions(values)
      : values.map((value) => ({ value, label: value }));
  }, [config, field]);

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({ field: "packageTypes", mode: "append", values: [] });
    setField("packageTypes");
  }, [form, open]);

  return (
    <Modal
      open={open}
      title={`批量修改标签 · ${count} 个案例`}
      okText="应用修改"
      cancelText="取消"
      confirmLoading={loading}
      onCancel={onCancel}
      onOk={() => void form.validateFields().then(onSubmit)}
    >
      <Typography.Paragraph className="secondary-text">
        “追加”会保留原标签；“移除”仅删掉所选值；“全部替换”会覆盖该分类下的现有标签。
        价位是单值字段：“追加”只补齐空价位，“全部替换”可留空以清空。
      </Typography.Paragraph>
      <Form<BatchTagValues>
        form={form}
        layout="vertical"
        requiredMark={false}
        onValuesChange={(changed) => {
          if (changed.field) {
            setField(changed.field as TagField);
            form.setFieldValue("values", []);
          }
        }}
      >
        <Form.Item name="field" label="标签分类" rules={[{ required: true }]}>
          <Select
            aria-label="标签分类"
            options={(
              ["packageTypes", "styles", "priceLevel", "scenes", "statuses"] as TagField[]
            ).map((value) => ({ value, label: tagFieldLabel(value) }))}
          />
        </Form.Item>
        <Form.Item name="mode" label="修改方式" rules={[{ required: true }]}>
          <Radio.Group optionType="button" buttonStyle="solid">
            <Radio.Button value="append">追加</Radio.Button>
            <Radio.Button value="remove">移除</Radio.Button>
            <Radio.Button value="replace">全部替换</Radio.Button>
          </Radio.Group>
        </Form.Item>
        <Form.Item
          name="values"
          label={tagFieldLabel(field)}
          rules={[
            ({ getFieldValue }) => ({
              validator(_, values: string[]) {
                if (getFieldValue("mode") === "replace" || values?.length) return Promise.resolve();
                return Promise.reject(new Error("请至少选择一个标签"));
              },
            }),
          ]}
        >
          <Select
            mode="multiple"
            maxCount={field === "priceLevel" ? 1 : undefined}
            allowClear
            aria-label="批量标签值"
            placeholder="选择要处理的标签"
            options={options}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}

export type { BatchTagValues };
