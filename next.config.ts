import type { NextConfig } from "next"

const config: NextConfig = {
  serverExternalPackages: ["@dbos-inc/dbos-sdk", "pg"],
  // Candidate builds use two cores on the default 4-core/8GB host.
  experimental: { cpus: 2 },
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
