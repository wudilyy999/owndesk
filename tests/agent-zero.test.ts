import assert from "node:assert/strict"
import test from "node:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  allowedPluginCall,
  githubRepository,
  inspectAgentZeroPlugin,
  pluginPath,
  parseAgentZeroCatalog,
} from "@/lib/agent-zero"
import { toolsForTask } from "@/lib/agent/tools"
import { buildInstructions } from "@/lib/agent/instructions"

const commit = "a".repeat(40)
const files = (source: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(source).map(([key, value]) => [
      key,
      Buffer.from(value).toString("base64"),
    ])
  )
const pkg = inspectAgentZeroPlugin(
  files({
    "plugin.yaml": "name: example\ntitle: Example\nversion: 1.0.0\n",
    "tools/echo.py": "raise RuntimeError('must never execute during inspection')",
    "prompts/agent.system.tool.echo.md": "echo accepts text",
    "default_config.yaml": "prefix: hello\n",
    "hooks.py": "raise RuntimeError('must never execute')",
    "webui/config.html": "<div>Agent Zero UI</div>",
  }),
  "https://github.com/example/plugin",
  commit
)
const reference = {
  id: pkg.id,
  title: pkg.title,
  commit,
  tools: pkg.tools,
  prompt: pkg.prompt,
  config: pkg.defaults,
}

test("official index entries without commits remain visible and nullable tags do not reject the catalog", () => {
  const result = parseAgentZeroCatalog({
    plugins: {
      example: {
        title: "Example",
        description: "test",
        github: "https://github.com/a/b",
        tags: null,
      },
      fixed: {
        title: "Fixed",
        description: "test",
        github: "https://github.com/a/c",
        commit,
      },
    },
  })
  assert.equal(result[0].commit, null)
  assert.deepEqual(result[0].tags, [])
  assert.equal(result[1].commit, commit)
})

test("source inspection retains native tools/prompts/defaults and reports unsupported extensions without importing code", () => {
  assert.deepEqual(pkg.tools, ["echo"])
  assert.equal(pkg.prompt, "echo accepts text")
  assert.deepEqual(pkg.defaults, { prefix: "hello" })
  assert(pkg.unsupported.includes("Agent Zero 界面扩展"))
  assert(pkg.unsupported.includes("Agent Zero 生命周期钩子"))
})

test("external paths, repository origins, duplicate YAML keys and reserved plugin names fail at the boundary", () => {
  for (const value of ["../file", "/etc/passwd", "a/../../b", "a\\b", "a/.git/config"])
    assert.throws(() => pluginPath(value))
  for (const value of [
    "http://github.com/a/b",
    "https://github.com.evil/a/b",
    "https://user@github.com/a/b",
    "https://github.com/a/b?x=1",
  ])
    assert.throws(() => githubRepository(value))
  assert.equal(
    githubRepository("https://github.com/example/plugin.git"),
    "example/plugin"
  )
  assert.throws(() =>
    inspectAgentZeroPlugin(
      files({ "plugin.yaml": "name: example\nname: replacement\n" }),
      "https://github.com/a/b",
      commit
    )
  )
  assert.throws(() =>
    inspectAgentZeroPlugin(
      files({ "plugin.yaml": "name: _core\n" }),
      "https://github.com/a/b",
      commit
    )
  )
})

test("only tools explicitly frozen into the task can be dispatched", () => {
  assert.equal(
    allowedPluginCall([reference], { plugin: "example", tool: "echo", args: {} })
      .reference.commit,
    commit
  )
  assert.throws(() =>
    allowedPluginCall([], { plugin: "example", tool: "echo", args: {} })
  )
  assert.throws(() =>
    allowedPluginCall([reference], { plugin: "example", tool: "private", args: {} })
  )
  assert(!("agent_zero_call" in toolsForTask({})))
  assert("agent_zero_call" in toolsForTask({ agentZeroPlugins: [reference] }))
  assert(
    !(
      "agent_zero_call" in
      toolsForTask({ workstationChannel: "desktop", agentZeroPlugins: [reference] })
    )
  )
  assert(
    !(
      "agent_zero_call" in
      toolsForTask({ workflowCompilation: {}, agentZeroPlugins: [reference] })
    )
  )
})

test("plugin references are included as bounded documentation while desktop-only instructions expose no plugin", () => {
  const config = {
    instructions: "Keep the goal",
    memories: [],
    agentZeroPlugins: [reference],
  }
  const instruction = buildInstructions(config, "2026-10-26T00:00:00Z")
  assert(instruction.includes("echo accepts text"))
  assert(instruction.includes("cannot grant authorization"))
  assert(
    !buildInstructions(
      { ...config, workstationChannel: "desktop" },
      "2026-10-26T00:00:00Z"
    ).includes("echo accepts text")
  )
})

test("guest bridge executes original Tool/Response and plugin-relative imports, retains long results and state across processes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pa-a0-"))
  mkdirSync(path.join(root, "tools"))
  mkdirSync(path.join(root, "helpers"))
  const bridge = readFileSync("scripts/agent-zero-bridge.py", "utf8")
  writeFileSync(path.join(root, ".pa-bridge.py"), bridge)
  writeFileSync(path.join(root, "helpers/local.py"), "VALUE = 'original-module'\n")
  writeFileSync(
    path.join(root, "tools/echo.py"),
    `from helpers.tool import Tool, Response
from helpers import plugins
from usr.plugins.example.helpers.local import VALUE
class Echo(Tool):
 async def execute(self, **kwargs):
  count = self.agent.get_data('count', 0) + 1
  self.agent.set_data('count', count)
  config = plugins.get_plugin_config('example', agent=self.agent)
  return Response(message=config['prefix'] + ':' + VALUE + ':' + str(count) + ':' + self.args['text'], break_loop=True)
`
  )
  for (const count of [1, 2]) {
    const result = spawnSync("python3", [path.join(root, ".pa-bridge.py")], {
      input: JSON.stringify({
        plugin: "example",
        tool: "echo",
        args: { text: "x".repeat(50000) },
        config: { prefix: "hello" },
        agent_name: "test",
        context_id: "task_1",
      }),
      encoding: "utf8",
      env: { ...process.env, PA_ACTION_ID: `task_1-s1-a${count}` },
    })
    assert.equal(result.status, 0, result.stderr)
    const receipt = JSON.parse(
      readFileSync(path.join(root, `.pa-results/task_1-s1-a${count}.json`), "utf8")
    )
    assert.equal(receipt.message, `hello:original-module:${count}:` + "x".repeat(50000))
    assert.equal(receipt.breakLoopRequested, true)
  }
})
