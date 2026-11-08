export function startMcpFixture(): Promise<{
  url: string
  writes: string[]
  tokens: Record<string, string>[]
  close: () => Promise<void>
}>
