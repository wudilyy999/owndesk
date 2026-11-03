import type { NextConfig } from "next"

const config: NextConfig = {
  serverExternalPackages: ["@dbos-inc/dbos-sdk", "pg"],
  async headers() {
    // A new service worker must be picked up on the next visit
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ]
  },
}

export default config
