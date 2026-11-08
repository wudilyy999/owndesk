import {
  workflowStepSchema,
  type WorkflowEnvironment,
  type WorkflowStep,
} from "@/lib/workflow-schema"
import { validateWorkflowPackage } from "@/lib/workflow-package"

export function crossAppTemplate(
  environment: WorkflowEnvironment,
  packageId: string,
  source: "Browser" | "Writer" = "Browser"
) {
  const zh = environment.locale.startsWith("zh_"),
    untitled = zh ? "未命名" : "Untitled"
  const guard = (application: "Browser" | "Writer" | "Mousepad", title: string) => ({
    application,
    title: [{ literal: title }],
  })
  const steps: WorkflowStep[] = []
  const add = (step: unknown, label: string) =>
    steps.push(
      workflowStepSchema.parse({
        ...(step as object),
        id: `step-${steps.length + 1}`,
        label,
        evidence: [],
      })
    )
  const key = (when: ReturnType<typeof guard>, key: string, modifiers: string[] = []) =>
    add(
      { operation: "key_press", when, key, modifiers } as WorkflowStep,
      `${modifiers.join("+")}${modifiers.length ? "+" : ""}${key}`
    )
  const type = (when: ReturnType<typeof guard>, value: string) =>
    add(
      { operation: "key_type", when, text: [{ literal: value }] } as WorkflowStep,
      "输入报表内容"
    )
  add(
    { operation: "open_application", application: source } as WorkflowStep,
    `打开 ${source}`
  )
  if (source === "Browser") {
    const blank = guard("Browser", "about:blank - Chromium")
    key(blank, "l", ["ctrl"])
    type(
      blank,
      "data:text/html,%3Ctitle%3EOwnDesk%20CSV%3C%2Ftitle%3E%3Cpre%3Ename%2Ctotal%0AExample%2C42%3C%2Fpre%3E"
    )
    key(blank, "enter")
    const page = guard("Browser", "OwnDesk CSV - Chromium")
    key(page, "a", ["ctrl"])
    key(page, "c", ["ctrl"])
  } else {
    const page = guard("Writer", `${zh ? "未命名" : "Untitled"} 1 — LibreOffice Writer`)
    type(page, "Name,total")
    key(page, "enter")
    type(page, "Example,42")
    key(page, "a", ["ctrl"])
    key(page, "c", ["ctrl"])
  }
  add(
    { operation: "open_application", application: "Mousepad" } as WorkflowStep,
    "打开文本编辑器"
  )
  const editor = guard("Mousepad", `${untitled} 1 - Mousepad`),
    modified = guard("Mousepad", `*${untitled} 1 - Mousepad`)
  key(editor, "v", ["ctrl"])
  key(modified, "s", ["ctrl"])
  const dialog = guard("Mousepad", zh ? "另存为" : "Save As")
  add(
    {
      operation: "key_type",
      when: dialog,
      text: [{ literal: "/home/agent/" }, { parameter: "input1" }, { literal: ".csv" }],
    } as WorkflowStep,
    "填写输出文件名"
  )
  key(dialog, "enter")
  add(
    {
      operation: "assert",
      window: {
        application: "Mousepad",
        title: [
          { literal: "~/" },
          { parameter: "input1" },
          { literal: ".csv - Mousepad" },
        ],
      },
    } as WorkflowStep,
    "核对保存窗口"
  )
  return validateWorkflowPackage({
    format: "personal-agent.workflow",
    formatVersion: 2,
    packageId,
    name: `${source} 到 CSV`,
    description: `从 ${source} 复制报表到文本编辑器，保存 CSV 后由宿主核对列和行。`,
    environment: { ...environment, application: "Desktop" },
    parameters: [{ name: "input1", label: "输出文件名（自动添加 .csv）" }],
    completion: { root: [{ literal: "/home/agent" }], directories: [], absent: [] },
    artifact: {
      path: [{ literal: "/home/agent/" }, { parameter: "input1" }, { literal: ".csv" }],
      requiredColumns: [source === "Writer" ? "Name" : "name", "total"],
      minRows: 1,
    },
    steps: steps.map(({ evidence: _evidence, ...step }) => step),
    testSamples: [1, 2, 3].map((n) => ({ input1: `Report-${n}` })),
  })
}
