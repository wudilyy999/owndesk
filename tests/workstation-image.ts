import { readFileSync } from "node:fs"

// The image the repository builds (`npm run workstation:build`), so acceptance tests follow version bumps
export const workstationImage =
  process.env.OWNDESK_TEST_IMAGE ??
  (JSON.parse(readFileSync("package.json", "utf8")).scripts["workstation:build"].match(
    /-t (\S+)/
  )[1] as string)
