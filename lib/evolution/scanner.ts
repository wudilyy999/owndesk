// Run the approved external scanner with its built-in rules. Candidate config,
// ignore files and gitleaks:allow comments cannot suppress a finding.
import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { SecretFinding } from "@/lib/evolution/policy"

// Consume the whole trusted Docker stream, including its final exit status. Retain
// only enough overlap to match a UTF-8 secret split between transport chunks.
export async function streamContainsSecret(
  stream: AsyncIterable<Uint8Array>,
  secrets: string[]
) {
  const needles = secrets.map((value) => Buffer.from(value))
  const overlap = Math.max(0, ...needles.map((value) => value.length - 1))
  let tail: Buffer = Buffer.alloc(0)
  let found = false
  for await (const chunk of stream) {
    const bytes = Buffer.concat([tail, chunk])
    found ||= needles.some((value) => bytes.includes(value))
    tail = overlap ? bytes.subarray(Math.max(0, bytes.length - overlap)) : Buffer.alloc(0)
  }
  return found
}

export async function scanWithGitleaks(
  lines: { path: string; line: number; text: string }[]
): Promise<SecretFinding[]> {
  if (!lines.length) return []
  const directory = await mkdtemp(path.join(os.tmpdir(), "owndesk-secret-scan-"))
  try {
    const result = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        "gitleaks",
        [
          "stdin",
          "--no-banner",
          "--no-color",
          "--redact=100",
          "--ignore-gitleaks-allow",
          "--log-level",
          "error",
          "--report-format",
          "json",
          "--report-path",
          "-",
          "--timeout",
          "30",
        ],
        {
          cwd: directory,
          encoding: "utf8",
          timeout: 45000,
          maxBuffer: 4 * 1024 * 1024,
          env: {
            NODE_ENV: process.env.NODE_ENV ?? "production",
            ...Object.fromEntries(
              Object.entries(process.env).filter(([key]) =>
                ["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"].includes(
                  key.toUpperCase()
                )
              )
            ),
          },
        },
        (error, stdout) => {
          if (error && error.code !== 1)
            reject(
              new Error(
                "Gitleaks 密钥扫描未完成；请检查可信运行环境中已安装 gitleaks 8.30.1"
              )
            )
          else resolve(stdout)
        }
      )
      child.stdin!.end(lines.map((line) => line.text).join("\n"))
    })
    const findings = JSON.parse(result || "[]") as { RuleID: string; StartLine: number }[]
    return findings.map((finding) => {
      const source = lines[finding.StartLine - 1]
      return {
        rule: `gitleaks:${finding.RuleID}`,
        path: source?.path ?? "candidate",
        line: source?.line ?? finding.StartLine,
      }
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
