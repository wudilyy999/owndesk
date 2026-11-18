import { Input } from "@/components/ui/input"

export const defaultDelivery = {
  path: "",
  columns: "",
  minRows: 1,
  dateColumn: "",
  dateFrom: "",
  dateTo: "",
  review: false,
}

export function DeliveryOptions({
  maxSteps,
  stepLimit,
  setStepLimit,
  delivery,
  setDelivery,
}: {
  maxSteps: number
  stepLimit: number
  setStepLimit: (value: number) => void
  delivery: typeof defaultDelivery
  setDelivery: (delivery: typeof defaultDelivery) => void
}) {
  return (
    <details className="rounded-xl border border-border/80 bg-surface/80 px-4 py-3 text-sm shadow-2xs open:space-y-3">
      <summary className="cursor-pointer font-medium">交付检查与执行额度（可选）</summary>
      <label className="mt-3 block space-y-1">
        模型步骤上限
        <Input
          aria-label="本次模型步骤上限"
          type="number"
          min={1}
          max={maxSteps}
          value={stepLimit}
          onChange={(event) => setStepLimit(+event.target.value)}
        />
      </label>
      <label className="block space-y-1">
        CSV 文件路径
        <Input
          aria-label="CSV 文件路径"
          value={delivery.path}
          onChange={(event) => setDelivery({ ...delivery, path: event.target.value })}
          placeholder="例如 report.csv"
        />
      </label>
      <label className="block space-y-1">
        必需字段（英文逗号分隔）
        <Input
          aria-label="CSV 必需字段"
          value={delivery.columns}
          onChange={(event) => setDelivery({ ...delivery, columns: event.target.value })}
          placeholder="date,amount"
        />
      </label>
      <label className="block space-y-1">
        最少数据行
        <Input
          aria-label="CSV 最少数据行"
          type="number"
          min={0}
          value={delivery.minRows}
          onChange={(event) => setDelivery({ ...delivery, minRows: +event.target.value })}
        />
      </label>
      <label className="block space-y-1">
        日期字段
        <Input
          aria-label="CSV 日期字段"
          value={delivery.dateColumn}
          onChange={(event) =>
            setDelivery({ ...delivery, dateColumn: event.target.value })
          }
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2 [&>label]:min-w-0 [&>label]:space-y-1">
        <label>
          开始日期
          <Input
            aria-label="CSV 开始日期"
            type="date"
            value={delivery.dateFrom}
            onChange={(event) =>
              setDelivery({ ...delivery, dateFrom: event.target.value })
            }
          />
        </label>
        <label>
          结束日期
          <Input
            aria-label="CSV 结束日期"
            type="date"
            value={delivery.dateTo}
            onChange={(event) => setDelivery({ ...delivery, dateTo: event.target.value })}
          />
        </label>
      </div>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={delivery.review}
          onChange={(event) => setDelivery({ ...delivery, review: event.target.checked })}
        />
        交付前由我确认
      </label>
      <p className="text-xs leading-5 text-muted-foreground">
        路径相对于工作站的主目录。CSV 检查覆盖字段、行数和日期范围。
      </p>
    </details>
  )
}
