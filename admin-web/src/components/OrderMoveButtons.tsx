import {
  ArrowDownOutlined,
  ArrowLeftOutlined,
  ArrowRightOutlined,
  ArrowUpOutlined,
} from "@ant-design/icons";
import { Button } from "antd";

export function OrderMoveButtons({
  index,
  total,
  ariaContext,
  onMove,
  axis = "vertical",
  disabled = false,
  className = "",
}: {
  index: number;
  total: number;
  ariaContext: string;
  onMove: (to: number) => void;
  axis?: "vertical" | "horizontal";
  disabled?: boolean;
  className?: string;
}) {
  const horizontal = axis === "horizontal";
  const previousLabel = horizontal ? "前移" : "上移";
  const nextLabel = horizontal ? "后移" : "下移";
  const PreviousIcon = horizontal ? ArrowLeftOutlined : ArrowUpOutlined;
  const NextIcon = horizontal ? ArrowRightOutlined : ArrowDownOutlined;

  return (
    <span className={`order-move-buttons ${className}`.trim()}>
      <Button
        type="text"
        size="small"
        icon={<PreviousIcon />}
        aria-label={`将${ariaContext}${previousLabel}`}
        title={previousLabel}
        disabled={disabled || index <= 0}
        onClick={(event) => {
          event.stopPropagation();
          onMove(index - 1);
        }}
      />
      <Button
        type="text"
        size="small"
        icon={<NextIcon />}
        aria-label={`将${ariaContext}${nextLabel}`}
        title={nextLabel}
        disabled={disabled || index >= total - 1}
        onClick={(event) => {
          event.stopPropagation();
          onMove(index + 1);
        }}
      />
    </span>
  );
}
