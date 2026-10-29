import { z } from "zod"
import { parseDocument } from "yaml"

export const pluginNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)
const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/)
export const pluginConfigSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (value) => JSON.stringify(value).length <= 8000,
    "Plugin configuration exceeds 8,000 characters"
  )
export const pluginReferenceSchema = z.object({
  id: pluginNameSchema,
  commit: revisionSchema,
  title: z.string(),
  tools: z.array(z.string()),
  prompt: z.string(),
  config: pluginConfigSchema,
})
export type AgentZeroPluginReference = z.infer<typeof pluginReferenceSchema>
export const pluginPackageSchema = z.object({
  id: pluginNameSchema,
  title: z.string().min(1).max(200),
  description: z.string().max(4000),
  version: z.string().max(100),
  repository: z.string(),
  commit: revisionSchema,
  files: z.record(z.string(), z.string()),
  tools: z.array(z.string()),
  prompt: z.string().max(24000),
  defaults: pluginConfigSchema,
  unsupported: z.array(z.string()),
})
export type AgentZeroPluginPackage = z.infer<typeof pluginPackageSchema>
export const pluginInstallationSchema = z.object({
  id: pluginNameSchema,
  commit: revisionSchema,
  repository: z.string(),
  title: z.string(),
  description: z.string(),
  version: z.string(),
  tools: z.array(z.string()),
  unsupported: z.array(z.string()),
  enabled: z.boolean(),
  config: pluginConfigSchema,
})
export type AgentZeroPluginInstallation = z.infer<typeof pluginInstallationSchema>
export const pluginCallSchema = z.object({
  plugin: pluginNameSchema,
  tool: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,100}$/),
  method: z.string().max(100).optional(),
  args: z.record(z.string(), z.unknown()),
})
export type AgentZeroPluginCall = z.infer<typeof pluginCallSchema>

export function parseAgentZeroCatalog(source: unknown) {
  const catalog = z
    .object({
      plugins: z.record(
        z.string(),
        z.object({
          title: z.string(),
          description: z.string(),
          github: z.string(),
          commit: revisionSchema.nullish(),
          tags: z.array(z.string()).nullish(),
        })
      ),
    })
    .parse(source)
  return Object.entries(catalog.plugins).map(([id, value]) => ({
    id,
    title: value.title,
    description: value.description,
    repository: value.github,
    commit: value.commit ?? null,
    tags: value.tags ?? [],
  }))
}

export function githubRepository(input: string) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)\/?$/.exec(
    input
  )
  if (!match || [match[1], match[2]].some((part) => part === "." || part === ".."))
    throw new Error(
      "Use a public GitHub repository URL without credentials or query parameters"
    )
  return `${match[1]}/${match[2].replace(/\.git$/, "")}`
}

export function pluginPath(input: string) {
  if (
    !input ||
    input.startsWith("/") ||
    input.includes("\\") ||
    input.includes("\0") ||
    input
      .split("/")
      .some((part) => !part || part === "." || part === ".." || part === ".git")
  )
    throw new Error(`Invalid plugin file path: ${input}`)
  return input
}

function yamlObject(source: string) {
  const doc = parseDocument(source, { uniqueKeys: true })
  if (doc.errors.length) throw new Error(doc.errors[0].message)
  return z.record(z.string(), z.unknown()).parse(doc.toJS({ maxAliasCount: 20 }))
}

// Inspect source only. Plugin imports, hooks and setup scripts execute exclusively in a guest.
export function inspectAgentZeroPlugin(
  files: Record<string, string>,
  repository: string,
  commit: string
): AgentZeroPluginPackage {
  githubRepository(repository)
  revisionSchema.parse(commit)
  const entries = Object.entries(files)
  if (
    entries.length > 200 ||
    entries.reduce((n, [, value]) => n + value.length, 0) > 1400000
  )
    throw new Error("Plugin package exceeds 200 files or the 1 MiB source limit")
  for (const [name, value] of entries) {
    pluginPath(name)
    if (Buffer.from(value, "base64").toString("base64") !== value)
      throw new Error(`Invalid file encoding: ${name}`)
  }
  if (!files["plugin.yaml"])
    throw new Error("The repository root must contain plugin.yaml")
  const manifest = yamlObject(Buffer.from(files["plugin.yaml"], "base64").toString())
  const id = pluginNameSchema.parse(manifest.name)
  const tools = entries
    .map(([name]) => /^tools\/([A-Za-z][A-Za-z0-9_]*)\.py$/.exec(name)?.[1])
    .filter((name): name is string => !!name)
    .sort()
  const prompts = entries
    .filter(([name]) => /^prompts\/agent\.system\.tool\..*\.md$/.test(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => Buffer.from(value, "base64").toString("utf8"))
    .join("\n\n")
  if (prompts.length > 24000)
    throw new Error("Plugin tool prompts exceed 24,000 characters")
  const unsupported: string[] = []
  const has = (prefix: string) => entries.some(([name]) => name.startsWith(prefix))
  if (has("webui/") || has("extensions/webui/")) unsupported.push("Agent Zero 界面扩展")
  if (has("extensions/python/") || files["hooks.py"])
    unsupported.push("Agent Zero 生命周期钩子")
  if (has("api/")) unsupported.push("Agent Zero 专属 API")
  if (has("skills/")) unsupported.push("插件附带的 Skill 自动发现")
  if (has("agents/") || has("conf/")) unsupported.push("Agent Zero 配置与子 Agent")
  if (files["execute.py"] || files["requirements.txt"] || files["pyproject.toml"])
    unsupported.push("自动安装依赖／安装脚本（需在容器中单独配置）")
  return pluginPackageSchema.parse({
    id,
    title: manifest.title ?? id,
    description: manifest.description ?? "",
    version: String(manifest.version ?? "unversioned"),
    repository,
    commit,
    files,
    tools,
    prompt: prompts,
    unsupported,
    defaults: files["default_config.yaml"]
      ? yamlObject(Buffer.from(files["default_config.yaml"], "base64").toString())
      : {},
  })
}

export function allowedPluginCall(references: AgentZeroPluginReference[], raw: unknown) {
  const call = pluginCallSchema.parse(raw)
  const reference = references.find((item) => item.id === call.plugin)
  if (!reference || !reference.tools.includes(call.tool))
    throw new Error("This plugin tool is not enabled in the task's frozen configuration")
  return { call, reference }
}
