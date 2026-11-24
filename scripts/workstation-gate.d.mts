export type WorkstationGate = { host: string; token: string; close: () => Promise<void> }
export function startWorkstationGate(config: {
  install: string
  owner: string
  stack: string
  image: string
  ref: string
  network: string
  agents: string[]
  host: string
  socketPath?: string
}): Promise<WorkstationGate>
