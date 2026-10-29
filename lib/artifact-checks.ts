import type { CompletionContract } from "@/db/schema"

export function verifyDirectoryTree(
  names: string[],
  types: string[],
  contract: NonNullable<CompletionContract["directoryTree"]>
) {
  const { root, directories, absent } = contract
  // directoryTreeSchema guarantees an absolute home path with no trailing slash.
  const prefix = `${root.slice(root.lastIndexOf("/") + 1)}/`
  if (
    types.length > 1000 ||
    types.length !== names.length ||
    types.some((line) => !["d", "-"].includes(line[0])) ||
    !names.includes(prefix) ||
    names.some(
      (name) =>
        name !== prefix && (!name.startsWith(prefix) || name.split("/").includes(".."))
    )
  )
    throw new Error(
      "Directory snapshot must contain a bounded tree of ordinary files and directories"
    )
  const entries = names.map((name, i) => ({
    path: name.slice(prefix.length).replace(/\/$/, ""),
    directory: types[i][0] === "d",
  }))
  for (const required of directories)
    if (!entries.some((entry) => entry.directory && entry.path === required))
      throw new Error(`Required directory is missing: ${required}`)
  for (const missing of absent)
    if (entries.some((entry) => entry.path === missing))
      throw new Error(`This path must be absent: ${missing}`)
  return {
    grade: "program_checked",
    checkerId: "directory-tree-v1",
    root,
    directories,
    absent,
    entries,
    checks: { hostReadOnlyArchive: true, linksRejected: true },
  }
}

// RFC-style CSV quoting, including escaped quotes and embedded CRLF/newlines.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [],
    row: string[] = []
  let value = "",
    quoted = false,
    closedQuote = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char !== '"') value += char
      else if (text[i + 1] === '"') {
        value += '"'
        i++
      } else {
        quoted = false
        closedQuote = true
      }
      continue
    }
    if (char === '"' && !value && !closedQuote) {
      quoted = true
      continue
    }
    if (char === ",") {
      row.push(value)
      value = ""
      closedQuote = false
      continue
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++
      row.push(value)
      rows.push(row.splice(0))
      value = ""
      closedQuote = false
      continue
    }
    if (closedQuote || char === '"') throw new Error("Invalid CSV quoting")
    value += char
  }
  if (quoted) throw new Error("Unclosed CSV quote")
  if (value || row.length || closedQuote) {
    row.push(value)
    rows.push(row)
  }
  return rows
}
export function verifyCsv(
  content: string,
  contract: NonNullable<CompletionContract["artifact"]>
) {
  const [header, ...rows] = parseCsv(content.replace(/^\uFEFF/, ""))
  if (
    !header?.length ||
    header.some((name) => !name) ||
    new Set(header).size !== header.length
  )
    throw new Error("CSV needs unique, nonempty column names")
  for (const column of contract.requiredColumns)
    if (!header.includes(column))
      throw new Error(`CSV is missing required column: ${column}`)
  if (rows.length < contract.minRows)
    throw new Error(`CSV has ${rows.length} rows; expected at least ${contract.minRows}`)
  if (rows.some((row) => row.length !== header.length))
    throw new Error("CSV contains rows with a different number of columns")
  if (contract.dateColumn) {
    const index = header.indexOf(contract.dateColumn)
    if (index < 0) throw new Error(`CSV is missing date column: ${contract.dateColumn}`)
    for (const row of rows) {
      const value = row[index]
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value
      )
        throw new Error(`Invalid ISO date in ${contract.dateColumn}: ${value}`)
      if (contract.dateFrom && value < contract.dateFrom)
        throw new Error(`Date ${value} precedes ${contract.dateFrom}`)
      if (contract.dateTo && value > contract.dateTo)
        throw new Error(`Date ${value} exceeds ${contract.dateTo}`)
    }
  }
  return {
    grade: "program_checked",
    checks: {
      requiredColumns: contract.requiredColumns,
      minRows: contract.minRows,
      rows: rows.length,
      dateColumn: contract.dateColumn ?? null,
      dateFrom: contract.dateFrom ?? null,
      dateTo: contract.dateTo ?? null,
    },
    unverified: [
      "Source data authenticity and general factual correctness are not established by CSV structure checks.",
    ],
  }
}
