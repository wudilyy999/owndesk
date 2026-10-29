import type { NextConfig } from "next"

const config: NextConfig = {
  serverExternalPackages: ["@dbos-inc/dbos-sdk", "pg"],
}

export default config
