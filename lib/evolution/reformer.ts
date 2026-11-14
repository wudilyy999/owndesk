// The reformer: a model working on the candidate copy inside the lab container. Its model
// requests are made here, in the trusted worker, so no key ever enters the lab. It can only
// read, search and write files and run the checks; what it says about tests never counts.
import { generateText, tool, type ModelMessage } from "ai"
import { z } from "zod"
import type { Objective } from "@/db/schema"
import { labExec, readLabFile, type LabContainer } from "@/lib/evolution/lab"
import {
  beginAttempt,
  finishAttempt,
  LabBudgetError,
  priceFor,
  SEGMENT,
  spendBlock,
} from "@/lib/evolution/meter"
import { isProtectedPath } from "@/lib/evolution/policy"
import { createModel } from "@/lib/providers/registry"

const MAX_TURNS = 60
const OUTPUT_CHARS = 12000

export type ReformerResult = { summary: string; turns: number; finished: boolean }

const relative = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.split("/").some((part) => part === ".." || part === ".git") &&
      /^[A-Za-z0-9_\-./[\]()@+ ]+$/.test(value),
    "Use a path relative to the project root"
  )
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
const clip = (text: string, limit = OUTPUT_CHARS) =>
  text.length > limit
    ? `${text.slice(0, limit / 2)}\n…(${text.length - limit} chars cut)…\n${text.slice(-limit / 2)}`
    : text

const tools = {
  list_files: tool({
    description: "List files under a directory of the project (not node_modules).",
    inputSchema: z.object({
      dir: relative.default("."),
      depth: z.number().int().min(1).max(6).default(2),
    }),
  }),
  read_file: tool({
    description: "Read a text file with line numbers. Use offset/limit for long files.",
    inputSchema: z.object({
      path: relative,
      offset: z.number().int().min(1).default(1),
      limit: z.number().int().min(1).max(800).default(400),
    }),
  }),
  search: tool({
    description:
      "Search the project for a regular expression (grep -E). Returns file:line:text.",
    inputSchema: z.object({
      pattern: z.string().min(1).max(200),
      dir: relative.default("."),
    }),
  }),
  write_file: tool({
    description: "Create or overwrite a text file with the full new content.",
    inputSchema: z.object({ path: relative, content: z.string().max(200000) }),
  }),
  edit_file: tool({
    description:
      "Replace one exact occurrence of old_text with new_text in a file. old_text must match exactly once.",
    inputSchema: z.object({
      path: relative,
      old_text: z.string().min(1).max(50000),
      new_text: z.string().max(50000),
    }),
  }),
  run_check: tool({
    description:
      "Run a check in the lab (no network): typecheck (tsc), lint (eslint on given files), format (prettier --write on given files), or unit tests (node test runner on given test files).",
    inputSchema: z.object({
      kind: z.enum(["typecheck", "lint", "format", "test"]),
      files: z.array(relative).max(20).default([]),
    }),
  }),
  finish: tool({
    description:
      "End this round when the change is complete and typecheck passes. Summarize in plain Chinese for the owner what changed and how to use it.",
    inputSchema: z.object({ summary: z.string().trim().min(1).max(2000) }),
  }),
}

type ToolInput<K extends keyof typeof tools> =
  (typeof tools)[K] extends import("ai").Tool<infer I> ? I : never

async function runTool(
  lab: LabContainer,
  name: string,
  input: Record<string, unknown>
): Promise<{ ok: boolean; output: string }> {
  switch (name) {
    case "list_files": {
      const { dir, depth } = (
        tools.list_files.inputSchema as unknown as z.ZodType<ToolInput<"list_files">>
      ).parse(input)
      const result = await labExec(
        lab,
        `find ${quote(dir)} -maxdepth ${depth} \\( -name node_modules -o -name .next -o -name .git \\) -prune -o -print | sort | head -400`
      )
      return { ok: result.code === 0, output: clip(result.output) }
    }
    case "read_file": {
      const { path, offset, limit } = (
        tools.read_file.inputSchema as unknown as z.ZodType<ToolInput<"read_file">>
      ).parse(input)
      const result = await labExec(
        lab,
        `test -f ${quote(path)} && awk -v s=${offset} -v e=${offset + limit - 1} 'NR>=s && NR<=e {printf "%d\\t%s\\n", NR, $0} END {print "(" NR " lines)"}' ${quote(path)}`
      )
      return { ok: result.code === 0, output: clip(result.output || "No such file") }
    }
    case "search": {
      const { pattern, dir } = (
        tools.search.inputSchema as unknown as z.ZodType<ToolInput<"search">>
      ).parse(input)
      const result = await labExec(
        lab,
        `grep -rnIE --exclude-dir=node_modules --exclude-dir=.next -e ${quote(pattern)} ${quote(dir)} | head -200`
      )
      return { ok: true, output: clip(result.output || "No matches") }
    }
    case "write_file": {
      const { path, content } = (
        tools.write_file.inputSchema as unknown as z.ZodType<ToolInput<"write_file">>
      ).parse(input)
      if (isProtectedPath(path))
        return {
          ok: false,
          output: `${path} is protected in this stage; do not change it.`,
        }
      const result = await labExec(
        lab,
        `mkdir -p "$(dirname ${quote(path)})" && cat > ${quote(path)}`,
        { input: content }
      )
      return {
        ok: result.code === 0,
        output: result.code === 0 ? "written" : result.output,
      }
    }
    case "edit_file": {
      const { path, old_text, new_text } = (
        tools.edit_file.inputSchema as unknown as z.ZodType<ToolInput<"edit_file">>
      ).parse(input)
      if (isProtectedPath(path))
        return {
          ok: false,
          output: `${path} is protected in this stage; do not change it.`,
        }
      const raw = await readLabFile(lab, path)
      if (raw === null) return { ok: false, output: "No such file" }
      const count = raw.split(old_text).length - 1
      if (count !== 1)
        return {
          ok: false,
          output: `old_text matched ${count} times; it must match exactly once`,
        }
      const result = await labExec(lab, `cat > ${quote(path)}`, {
        input: raw.replace(old_text, () => new_text),
      })
      return {
        ok: result.code === 0,
        output: result.code === 0 ? "edited" : result.output,
      }
    }
    case "run_check": {
      const { kind, files } = (
        tools.run_check.inputSchema as unknown as z.ZodType<ToolInput<"run_check">>
      ).parse(input)
      const list = files.map(quote).join(" ")
      const command =
        kind === "typecheck"
          ? "npx tsc --noEmit -p ."
          : kind === "lint"
            ? `npx eslint ${list || "app components lib worker"}`
            : kind === "format"
              ? `npx prettier --write ${list || "--check app components lib worker"}`
              : `npx tsx --import ./tests/setup-env.mjs --test ${list || "tests/*.test.ts"}`
      const result = await labExec(
        lab,
        `${command} > /tmp/check.log 2>&1; code=$?; tail -c 12000 /tmp/check.log; exit $code`,
        { timeoutMs: 600000 }
      )
      return { ok: result.code === 0, output: clip(result.output || "(no output)") }
    }
  }
  return { ok: false, output: `Unknown tool ${name}` }
}

export function reformerSystem(rules: string) {
  return [
    "You are the reformer of the OwnDesk improvement lab. You change a copy of the OwnDesk source code (a Next.js 16 + React 19 + TypeScript app with a Node worker, Postgres via drizzle) so it does what the owner asked. You work in an isolated lab with no network.",
    "Rules for this stage (B1):",
    "- You may change app/, components/, lib/ and worker/ and add NEW test files under tests/ (name them *.test.ts so `npm test` runs them). Never modify or delete existing tests.",
    "- Never change: lib/evolution/, scripts/, deploy/, Dockerfile, workstation/, db/ (no schema or migration changes), package.json or package-lock.json (no new dependencies), auth, secrets, vault, spend/budget, network guard, docker, workstation, desktop and agent tool code. Changes there are rejected automatically.",
    "- Read before you edit; keep the change small and focused; match the existing code style; keep user-facing text in Simplified Chinese like the rest of the UI.",
    "- Add at least one unit test for new logic. Run typecheck before finishing and fix every error. Format the files you changed with run_check format.",
    "- Claims about tests count for nothing: an independent evaluator rebuilds and retests everything.",
    rules ? `Project development rules (AGENTS.md, excerpt):\n${rules}` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

export async function runReformer(input: {
  objective: Objective
  taskId: string
  spec: string
  lab: LabContainer
  brief: string
  rules: string
  maxTurns?: number
  log?: (line: string) => void
}): Promise<ReformerResult> {
  const model = await createModel(input.spec)
  const price = await priceFor(input.spec)
  const messages: ModelMessage[] = [{ role: "user", content: input.brief }]
  let typecheckFailures = 0
  for (let turn = 1; turn <= (input.maxTurns ?? MAX_TURNS); turn++) {
    const blocked = await spendBlock(input.objective, input.spec)
    if (blocked) throw new LabBudgetError(blocked)
    const attempt = await beginAttempt(input.taskId, SEGMENT.reformer, input.spec, price)
    let result
    try {
      result = await generateText({
        model,
        system: reformerSystem(input.rules),
        messages,
        tools,
        toolChoice: "required",
        maxRetries: 2,
        maxOutputTokens: 16000,
        abortSignal: AbortSignal.timeout(300000),
      })
    } catch (error) {
      await finishAttempt(attempt, price, null, String(error))
      throw error
    }
    await finishAttempt(attempt, price, {
      input: result.totalUsage.inputTokens ?? 0,
      output: result.totalUsage.outputTokens ?? 0,
      cached: result.totalUsage.inputTokenDetails?.cacheReadTokens ?? 0,
    })
    messages.push(...(result.response.messages as ModelMessage[]))
    if (!result.toolCalls.length) {
      messages.push({
        role: "user",
        content: "Use a tool. Call finish when the change is done.",
      })
      continue
    }
    const results: ModelMessage = { role: "tool", content: [] }
    for (const call of result.toolCalls) {
      const args = call.input as Record<string, unknown>
      if (call.toolName === "finish") {
        const summary = String(args.summary ?? "").slice(0, 2000)
        const check = await runTool(input.lab, "run_check", { kind: "typecheck" })
        input.log?.(`turn ${turn}: finish (typecheck ${check.ok ? "ok" : "failed"})`)
        if (check.ok || typecheckFailures >= 2)
          return { summary, turns: turn, finished: true }
        typecheckFailures++
        results.content.push({
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: {
            type: "text",
            value: `Typecheck fails; fix it before finishing:\n${check.output}`,
          },
        })
        continue
      }
      let outcome: { ok: boolean; output: string }
      try {
        outcome = await runTool(input.lab, call.toolName, args)
      } catch (error) {
        outcome = {
          ok: false,
          output: error instanceof Error ? error.message : String(error),
        }
      }
      input.log?.(`turn ${turn}: ${call.toolName} ${outcome.ok ? "ok" : "failed"}`)
      results.content.push({
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: {
          type: "text",
          value: `${outcome.ok ? "" : "ERROR: "}${outcome.output}`,
        },
      })
    }
    if ((results.content as unknown[]).length) messages.push(results)
  }
  return {
    summary: "改造者用完了这一轮的步数，没有说完成",
    turns: MAX_TURNS,
    finished: false,
  }
}
