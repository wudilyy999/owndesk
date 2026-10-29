import { sql } from "drizzle-orm"
import { db } from "@/db"
import { agents } from "@/db/schema"

export function listAgents() {
  return db
    .select()
    .from(agents)
    .where(sql`${agents.model} IS DISTINCT FROM 'fixture/durable-report'`)
}
