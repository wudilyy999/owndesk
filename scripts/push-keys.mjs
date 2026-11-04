// Adds VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY to .env when they are missing (web notifications).
// The keys are written to the gitignored .env with mode 600 and are never printed.
// Changing them later invalidates every browser's existing subscription (people allow again).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { generateVapidKeys } from "./vapid-keys.mjs"

const file = process.argv[2] ?? ".env"
const text = existsSync(file) ? readFileSync(file, "utf8") : ""
if (/^VAPID_PRIVATE_KEY=./m.test(text) && /^VAPID_PUBLIC_KEY=./m.test(text)) {
  console.log(`${file} already has VAPID keys; left unchanged.`)
} else {
  const { publicKey, privateKey } = generateVapidKeys()
  const lines = text
    .split("\n")
    .filter((line) => !/^VAPID_(PUBLIC|PRIVATE)_KEY=/.test(line))
    .join("\n")
  const body = `${lines}${lines && !lines.endsWith("\n") ? "\n" : ""}VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${privateKey}\n`
  if (existsSync(file)) writeFileSync(file, body)
  else appendFileSync(file, body, { mode: 0o600 })
  console.log(`VAPID keys written to ${file}. They were not printed.`)
}
