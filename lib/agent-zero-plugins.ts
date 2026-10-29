import { z } from "zod"
import { pool } from "@/db"
import { HttpError } from "@/lib/errors"
import {
  githubRepository,
  inspectAgentZeroPlugin,
  pluginInstallationSchema,
  pluginPackageSchema,
  pluginPath,
  parseAgentZeroCatalog,
  type AgentZeroPluginInstallation,
  type AgentZeroPluginReference,
} from "@/lib/agent-zero"

const registryKey = "plugins.agentZero.registry"
const packageKey = (id: string, commit: string) =>
  `plugins.agentZero.package.${id}.${commit}`

async function download(url: string, maxBytes: number) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Personal-Agent-Plugin-Compatibility",
      Accept: "application/vnd.github+json",
    },
    signal: AbortSignal.timeout(30000),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new HttpError(
      502,
      `GitHub returned ${response.status}; check the repository/ref or API rate limit`
    )
  }
  const reader = response.body!.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > maxBytes) {
        await reader.cancel()
        throw new HttpError(413, "Plugin download exceeded its size limit")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

export async function pluginCatalog() {
  const source = JSON.parse(
    (
      await download(
        "https://github.com/agent0ai/a0-plugins/releases/download/generated-index/index.json",
        4000000
      )
    ).toString()
  )
  return parseAgentZeroCatalog(source)
}

export async function installedAgentZeroPlugins(): Promise<
  AgentZeroPluginInstallation[]
> {
  const {
    rows: [row],
  } = await pool.query("SELECT value FROM settings WHERE key=$1", [registryKey])
  return row ? z.array(pluginInstallationSchema).parse(JSON.parse(row.value)) : []
}

async function changeInstallations(
  mutate: (current: AgentZeroPluginInstallation[]) => AgentZeroPluginInstallation[]
) {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT pg_advisory_xact_lock(71261210)")
    const {
      rows: [row],
    } = await client.query("SELECT value FROM settings WHERE key=$1", [registryKey])
    const next = mutate(
      row ? z.array(pluginInstallationSchema).parse(JSON.parse(row.value)) : []
    )
    const enabled = next.filter((item) => item.enabled)
    if (enabled.length > 12)
      throw new HttpError(400, "Enable at most 12 plugins per installation")
    await client.query(
      "INSERT INTO settings(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=now()",
      [registryKey, JSON.stringify(next)]
    )
    await client.query("COMMIT")
    return next
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export async function installAgentZeroPlugin(
  repository: string,
  ref = "HEAD",
  expectedName?: string
) {
  let repo: string
  try {
    repo = githubRepository(repository)
  } catch (error) {
    throw new HttpError(400, (error as Error).message)
  }
  const commitData = z
    .object({ sha: z.string().regex(/^[a-f0-9]{40}$/) })
    .parse(
      JSON.parse(
        (
          await download(
            `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`,
            2000000
          )
        ).toString()
      )
    )
  const tree = z
    .object({
      truncated: z.boolean(),
      tree: z.array(
        z.object({
          path: z.string(),
          mode: z.string(),
          type: z.string(),
          size: z.number().optional(),
        })
      ),
    })
    .parse(
      JSON.parse(
        (
          await download(
            `https://api.github.com/repos/${repo}/git/trees/${commitData.sha}?recursive=1`,
            2000000
          )
        ).toString()
      )
    )
  if (tree.truncated)
    throw new HttpError(400, "Repository is too large for a plugin package")
  const blobs = tree.tree.filter((entry) => entry.type !== "tree")
  if (blobs.some((entry) => entry.mode === "120000" || entry.type !== "blob"))
    throw new HttpError(
      400,
      "Plugin packages must contain regular files; symlinks and submodules are unsupported"
    )
  if (blobs.length > 200 || blobs.reduce((n, item) => n + (item.size ?? 0), 0) > 1048576)
    throw new HttpError(400, "Repository exceeds 200 files or the 1 MiB plugin limit")
  const files: Record<string, string> = {}
  // Bounded batches keep repository fetching independent of plugin code and install hooks.
  for (let offset = 0; offset < blobs.length; offset += 8) {
    const batch = await Promise.all(
      blobs.slice(offset, offset + 8).map(async (entry) => {
        pluginPath(entry.path)
        const body = await download(
          `https://raw.githubusercontent.com/${repo}/${commitData.sha}/${entry.path.split("/").map(encodeURIComponent).join("/")}`,
          1048576
        )
        return [entry.path, body.toString("base64")] as const
      })
    )
    for (const [name, value] of batch) files[name] = value
  }
  let pkg
  try {
    pkg = inspectAgentZeroPlugin(files, `https://github.com/${repo}`, commitData.sha)
  } catch (error) {
    throw new HttpError(400, (error as Error).message)
  }
  if (expectedName && expectedName !== pkg.id)
    throw new HttpError(400, "Plugin manifest name differs from the selected index entry")
  await pool.query(
    "INSERT INTO settings(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO NOTHING",
    [packageKey(pkg.id, pkg.commit), JSON.stringify(pkg)]
  )
  return changeInstallations((current) => {
    const prior = current.find((item) => item.id === pkg.id)
    if (prior && prior.repository.toLowerCase() !== pkg.repository.toLowerCase())
      throw new HttpError(409, "Another repository already owns this plugin name")
    if (prior?.commit === pkg.commit) return current
    return [
      ...current.filter((item) => item.id !== pkg.id),
      {
        id: pkg.id,
        commit: pkg.commit,
        repository: pkg.repository,
        title: pkg.title,
        description: pkg.description,
        version: pkg.version,
        tools: pkg.tools,
        unsupported: pkg.unsupported,
        config: prior?.config ?? pkg.defaults,
        enabled: false,
      },
    ]
  })
}

export async function configureAgentZeroPlugin(
  id: string,
  enabled: boolean,
  config: Record<string, unknown>
) {
  return changeInstallations((current) => {
    const prior = current.find((item) => item.id === id)
    if (!prior) throw new HttpError(404, "Plugin not installed")
    if (enabled && !prior.tools.length)
      throw new HttpError(400, "This plugin has no supported Python tool entrypoints")
    return current.map((item) => (item.id === id ? { ...item, enabled, config } : item))
  })
}

export async function loadAgentZeroPackage(id: string, commit: string) {
  const {
    rows: [row],
  } = await pool.query("SELECT value FROM settings WHERE key=$1", [
    packageKey(id, commit),
  ])
  if (!row) throw new Error("The task's pinned Agent Zero plugin package is missing")
  return pluginPackageSchema.parse(JSON.parse(row.value))
}

export async function agentZeroPluginSnapshot(): Promise<AgentZeroPluginReference[]> {
  const active = (await installedAgentZeroPlugins()).filter((item) => item.enabled)
  const references = await Promise.all(
    active.map(async (item) => ({
      id: item.id,
      commit: item.commit,
      title: item.title,
      tools: item.tools,
      config: item.config,
      prompt: (await loadAgentZeroPackage(item.id, item.commit)).prompt,
    }))
  )
  if (references.reduce((n, item) => n + item.prompt.length, 0) > 48000)
    throw new HttpError(
      409,
      "Enabled plugin prompts exceed 48,000 characters; disable unused plugins"
    )
  return references
}
