import type { Server, IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocket, WebSocketServer } from "ws"
import { pool } from "@/db"
import { isSameOrigin, requireOwner } from "@/lib/auth"
import { env } from "@/lib/env"
import { HttpError } from "@/lib/errors"
import { openDesktopStream, workspaceRow } from "@/lib/workstation"

type Connection = {
  client: WebSocket
  upstream?: Duplex
  agentId: string
  mode: "watch" | "control"
  epoch: number
  sessionId: string
  headers: Headers
  closed: boolean
}
const connections = new Set<Connection>()

function terminate(connection: Connection) {
  connection.closed = true
  connection.client.terminate()
  connection.upstream?.destroy()
}

export async function revokeDesktop(agentId: string) {
  const affected = [...connections].filter((c) => c.agentId === agentId)
  await Promise.all(
    affected.map(async (connection) => {
      connection.closed = true
      const sockets = [connection.client, connection.upstream].filter(
        (s): s is WebSocket | Duplex => !!s
      )
      await Promise.all(
        sockets.map(
          (socket) =>
            new Promise<void>((resolve, reject) => {
              if (
                socket instanceof WebSocket
                  ? socket.readyState === WebSocket.CLOSED
                  : socket.closed
              ) {
                resolve()
                return
              }
              const timeout = setTimeout(
                () => reject(new Error("Desktop connection did not close")),
                5000
              )
              socket.once("close", () => {
                clearTimeout(timeout)
                resolve()
              })
              if (socket instanceof WebSocket) socket.terminate()
              else socket.destroy()
            })
        )
      )
    })
  )
}

async function validateConnection(connection: Connection) {
  const owner = await requireOwner(connection.headers)
  if (owner.sessionId !== connection.sessionId)
    throw new HttpError(401, "Desktop session was revoked")
  const workspace = await workspaceRow(connection.agentId)
  const canControl =
    !workspace.desiredMode &&
    (workspace.mode === "human" || (workspace.mode === "idle" && !workspace.activeTaskId))
  if (
    workspace.epoch !== connection.epoch ||
    workspace.mode === "quarantined" ||
    (connection.mode === "control" && !canControl)
  ) {
    throw new HttpError(409, "Desktop control changed")
  }
}

export function attachDesktopGateway(server: Server) {
  const gateway = new WebSocketServer({
    noServer: true,
    maxPayload: 16000000,
    handleProtocols: (protocols) => (protocols.has("binary") ? "binary" : false),
  })
  server.on("upgrade", (request: IncomingMessage, socket, head) => {
    void (async () => {
      if (!isSameOrigin(request.headers.origin))
        throw new HttpError(403, "Desktop origin rejected")
      const match = /^\/desktop\/([a-zA-Z0-9_-]+)$/.exec(request.url ?? "")
      if (!match) throw new HttpError(404, "Unknown desktop")
      const headers = new Headers()
      for (const [key, value] of Object.entries(request.headers))
        if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value)
      const owner = await requireOwner(headers)
      const token = (request.headers["sec-websocket-protocol"] ?? "")
        .split(",")
        .map((s) => s.trim())
        .find((s) => s.startsWith("pa-token."))
        ?.slice(9)
      if (!token) throw new HttpError(401, "Desktop ticket required")
      const {
        rows: [ticket],
      } = await pool.query<{ mode: "watch" | "control"; epoch: number }>(
        `
        UPDATE desktop_tickets t SET used_at=now() FROM workstation_control w
        WHERE t.token=$1 AND t.owner_id=$2 AND t.session_id=$3 AND t.agent_id=$4
          AND t.used_at IS NULL AND t.expires_at>now() AND w.agent_id=t.agent_id AND w.epoch=t.epoch
          AND w.mode <> 'quarantined' AND (t.mode='watch' OR (w.desired_mode IS NULL AND (w.mode='human' OR (w.mode='idle' AND w.active_task_id IS NULL))))
        RETURNING t.mode,t.epoch`,
        [token, owner.userId, owner.sessionId, match[1]]
      )
      if (!ticket)
        throw new HttpError(401, "Desktop ticket expired, used or no longer authorized")
      gateway.handleUpgrade(request, socket, head, (client) => {
        const connection: Connection = {
          client,
          agentId: match[1],
          mode: ticket.mode,
          epoch: ticket.epoch,
          sessionId: owner.sessionId,
          headers,
          closed: false,
        }
        connections.add(connection)
        client.pause()
        let checking = false
        const sessionCheck = setInterval(() => {
          if (checking || connection.closed) return
          checking = true
          void validateConnection(connection)
            .catch((error) => {
              if (!(error instanceof HttpError))
                console.error("Desktop authorization check failed", error)
              terminate(connection)
            })
            .finally(() => {
              checking = false
            })
        }, 2000)
        client.on("close", () => {
          connection.closed = true
          clearInterval(sessionCheck)
          connection.upstream?.destroy()
          connections.delete(connection)
        })
        client.on("error", () => terminate(connection))
        client.on("message", (data, binary) => {
          if (connection.closed) return
          if (!binary) {
            terminate(connection)
            return
          }
          if (connection.upstream && !connection.upstream.write(data)) {
            client.pause()
            connection.upstream.once("drain", () => {
              if (!connection.closed) client.resume()
            })
          }
        })
        void (async () => {
          const upstream = await openDesktopStream(connection.agentId, connection.mode)
          connection.upstream = upstream
          upstream.on("error", (error) => {
            console.error("Desktop relay failed", error.message)
            terminate(connection)
          })
          if (connection.closed) {
            upstream.destroy()
            return
          }
          upstream.on("data", (data: Buffer) => {
            if (connection.closed || client.readyState !== WebSocket.OPEN) return
            upstream.pause()
            client.send(data, { binary: true }, (error) => {
              if (error) terminate(connection)
              else if (!connection.closed) upstream.resume()
            })
          })
          upstream.on("close", () => {
            if (client.readyState === WebSocket.OPEN)
              client.close(1012, "Desktop disconnected")
            else client.terminate()
          })
          upstream.on("end", () => upstream.destroy())
          await validateConnection(connection)
          if (!connection.closed) client.resume()
        })().catch((error) => {
          console.error("Desktop upstream unavailable", error)
          terminate(connection)
        })
      })
    })().catch((error) => {
      const status = error instanceof HttpError ? error.status : 500
      if (status === 500) console.error("Desktop handshake failed", error)
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`)
    })
  })
  return async () => {
    for (const connection of connections) terminate(connection)
    gateway.close()
  }
}
