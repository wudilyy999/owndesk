#!/usr/bin/env node
// Sample BYOK cost from companion_usage over the last N days. Does not invent prices —
// only sums what was recorded. Run on the host with DATABASE_URL set.
import pg from "pg"

const days = Number(process.argv[2] || 3)
const url = process.env.DATABASE_URL
if (!url) {
  console.error("Set DATABASE_URL")
  process.exit(1)
}
const pool = new pg.Pool({ connectionString: url })
const { rows } = await pool.query(
  `SELECT date_trunc('day', created_at) AS day,
          model,
          count(*)::int AS calls,
          coalesce(sum(cost_micros),0)::bigint AS cost_micros
     FROM companion_usage
    WHERE created_at > now() - ($1 || ' days')::interval
    GROUP BY 1, 2
    ORDER BY 1, 2`,
  [days]
)
let total = 0n
for (const row of rows) {
  total += BigInt(row.cost_micros)
  const usd = Number(row.cost_micros) / 1_000_000
  console.log(
    `${row.day.toISOString().slice(0, 10)}  ${row.model}  calls=${row.calls}  ~$${usd.toFixed(4)}`
  )
}
console.log(
  `total_micros=${total}  ~$${(Number(total) / 1_000_000).toFixed(4)}  (last ${days} days)`
)
console.log("Note: unpriced / unknown model calls may be missing from cost_micros.")
await pool.end()
