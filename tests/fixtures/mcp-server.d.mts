export function startMcpFixture(): Promise<{
  url: string
  reads: string[]
  writes: string[]
  tokens: Record<string, string>[]
  close: () => Promise<void>
}>
