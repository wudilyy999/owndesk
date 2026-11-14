// Stage 0 of the evaluator (B1): rules a candidate change must pass before anything is
// built. Pure functions over the change list and the added lines, so the rules are easy to
// test and the candidate can never see or change them (lib/evolution/** is protected).

export const B1_DIFF_LINE_LIMIT = 1500

// Paths only an official upgrade may change. B1 also keeps the computer (workstation,
// desktop and browser control) out of reach; that opens up in B2.
const PROTECTED: RegExp[] = [
  /^lib\/evolution\//,
  /^scripts\//,
  /^deploy\//,
  /^Dockerfile$/,
  /^\.dockerignore$/,
  /^workstation\//,
  /^db\//,
  /^drizzle\.config\.ts$/,
  /^package(-lock)?\.json$/,
  /^lib\/auth(-client)?\.ts$/,
  /^lib\/secrets\.ts$/,
  /^lib\/vault[^/]*\.ts$/,
  /^lib\/connection-endpoint\.ts$/,
  /^lib\/connection-fetch\.ts$/,
  /^lib\/spend\.ts$/,
  /^lib\/env\.ts$/,
  /^lib\/versions\.ts$/,
  /^lib\/docker\.ts$/,
  /^lib\/workstation\.ts$/,
  /^lib\/desktop\.ts$/,
  /^lib\/agent\//,
  /^worker\/budgets\.ts$/,
  /^worker\/network\.ts$/,
  /^worker\/control\.ts$/,
  /^worker\/desktop-gateway\.ts$/,
  /^worker\/actions\.ts$/,
  /^\.github\//,
  /^LICENSE$/,
  /^THIRD_PARTY\.md$/,
  /^provenance\.json$/,
  /^licenses\//,
  /^AGENTS\.md$/,
]
// Where a B1 candidate may work at all
const ALLOWED: RegExp[] = [/^app\//, /^components\//, /^lib\//, /^worker\//, /^tests\//]

export type ChangedFile = {
  path: string
  // A = added, M = modified, D = deleted, R = renamed (path is the new one, from the old)
  status: "A" | "M" | "D" | "R"
  from?: string
  added: number
  removed: number
  binary?: boolean
}

export type PolicyFinding = { rule: string; path?: string; detail: string }

export function isProtectedPath(file: string) {
  return PROTECTED.some((rule) => rule.test(file))
}

export function checkChanges(
  files: ChangedFile[],
  { lineLimit = B1_DIFF_LINE_LIMIT }: { lineLimit?: number } = {}
): PolicyFinding[] {
  const findings: PolicyFinding[] = []
  if (!files.length) findings.push({ rule: "empty", detail: "这一版没有任何改动" })
  for (const file of files) {
    const paths = [file.path, ...(file.from ? [file.from] : [])]
    for (const item of paths) {
      if (item.split("/").some((part) => part === ".." || part === ".git"))
        findings.push({ rule: "path", path: item, detail: "路径不合法" })
      if (/^db\/migrations\//.test(item))
        findings.push({
          rule: "migration",
          path: item,
          detail: "第一阶段不能改数据库结构（追加式迁移属于 B2）",
        })
      else if (/^package(-lock)?\.json$/.test(item))
        findings.push({
          rule: "dependencies",
          path: item,
          detail: "第一阶段不能加或改第三方软件包",
        })
      else if (isProtectedPath(item))
        findings.push({
          rule: "protected",
          path: item,
          detail:
            "这是受保护的部分（评测、预算、登录、密钥、工作站等），只能随官方版本更新",
        })
      else if (!ALLOWED.some((rule) => rule.test(item)))
        findings.push({
          rule: "scope",
          path: item,
          detail: "第一阶段只能改 app/、components/、lib/、worker/ 和新增测试",
        })
    }
    // Existing tests are frozen; a candidate may only add new test files
    if (/^tests\//.test(file.path) || (file.from && /^tests\//.test(file.from))) {
      if (file.status !== "A")
        findings.push({
          rule: "frozen-test",
          path: file.from ?? file.path,
          detail: "不能改或删已有的测试，只能新增测试文件",
        })
    }
    if (file.binary && file.status !== "D")
      findings.push({ rule: "binary", path: file.path, detail: "不接受二进制文件" })
  }
  const lines = files.reduce((sum, file) => sum + file.added + file.removed, 0)
  if (lines > lineLimit)
    findings.push({
      rule: "size",
      detail: `改动 ${lines} 行，超过上限 ${lineLimit} 行；请拆成更小的改进`,
    })
  return dedupe(findings)
}

function dedupe(findings: PolicyFinding[]) {
  const seen = new Set<string>()
  return findings.filter((item) => {
    const key = `${item.rule}\u0000${item.path ?? ""}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// Secret scan over the lines a candidate adds. The rule shapes follow the public
// gitleaks rule set (MIT; ideas only, no code copied); exact values of this
// installation's own secrets are matched as well.
const SECRET_RULES: { id: string; pattern: RegExp }[] = [
  { id: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { id: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { id: "github-fine-grained", pattern: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { id: "openai-key", pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/ },
  { id: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "slack-token", pattern: /\bxox[abpors]-[A-Za-z0-9-]{10,}\b/ },
  { id: "telegram-bot-token", pattern: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/ },
  { id: "stripe-key", pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  {
    id: "generic-api-key",
    pattern:
      /(?:api[_-]?key|secret|token|passw(?:or)?d)["']?\s*[:=]\s*["'][A-Za-z0-9_\-+/=]{24,}["']/i,
  },
]

export type SecretFinding = { rule: string; path: string; line: number }

export function scanAddedLines(
  added: { path: string; line: number; text: string }[],
  knownSecrets: string[] = []
): SecretFinding[] {
  const exact = knownSecrets.filter((value) => value && value.length >= 12)
  const findings: SecretFinding[] = []
  for (const item of added) {
    for (const rule of SECRET_RULES)
      if (rule.pattern.test(item.text))
        findings.push({ rule: rule.id, path: item.path, line: item.line })
    if (exact.some((value) => item.text.includes(value)))
      findings.push({ rule: "installation-secret", path: item.path, line: item.line })
  }
  return findings
}

// Added lines of a unified diff (git diff -U0 --no-color)
export function addedLines(patch: string) {
  const result: { path: string; line: number; text: string }[] = []
  let file = ""
  let line = 0
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw.slice(4).replace(/^b\//, "")
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) {
      line = Number(hunk[1])
      continue
    }
    if (raw.startsWith("+") && file && file !== "/dev/null") {
      result.push({ path: file, line, text: raw.slice(1) })
      line++
    }
  }
  return result
}
