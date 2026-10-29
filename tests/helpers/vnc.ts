import assert from "node:assert/strict"
import { createCipheriv } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { WebSocket } from "ws"

export async function connectVnc(
  ticket: { url: string; token: string; password: string },
  origin: string,
  cookie: string,
  ca?: Buffer
) {
  const socket = new WebSocket(ticket.url, ["binary", `pa-token.${ticket.token}`], {
    origin,
    headers: { Cookie: cookie },
    ca,
  })
  let received: Buffer = Buffer.alloc(0)
  let failure: Error | undefined
  let closed = false,
    closeReason = ""
  socket.on("message", (data) => {
    received = Buffer.concat([received, Buffer.from(data as Buffer)])
  })
  socket.on("error", (error) => {
    failure = error
  })
  socket.on("close", (code, reason) => {
    closed = true
    closeReason = `${code}: ${reason.toString()}`
  })
  async function take(count: number) {
    const deadline = Date.now() + 10000
    while (received.length < count) {
      if (failure) throw failure
      if (closed) throw new Error(`VNC closed during handshake: ${closeReason}`)
      if (Date.now() > deadline)
        throw new Error(
          `VNC handshake timed out; wanted ${count}, have ${received.length}`
        )
      await delay(10)
    }
    const result = received.subarray(0, count)
    received = received.subarray(count)
    return result
  }
  assert.match((await take(12)).toString(), /^RFB /)
  socket.send(Buffer.from("RFB 003.008\n"))
  const types = await take((await take(1))[0])
  assert(types.includes(2), "The VNC service must require password authentication")
  socket.send(Buffer.from([2]))
  const challenge = await take(16)
  const key = Buffer.alloc(8)
  Buffer.from(ticket.password).copy(key, 0, 0, 8)
  for (let i = 0; i < 8; i++) {
    let value = key[i],
      reversed = 0
    for (let bit = 0; bit < 8; bit++) {
      reversed = (reversed << 1) | (value & 1)
      value >>>= 1
    }
    key[i] = reversed
  }
  // Triple-DES with three identical keys is DES, available in Node's standard crypto module.
  const cipher = createCipheriv("des-ede3-ecb", Buffer.concat([key, key, key]), null)
  cipher.setAutoPadding(false)
  socket.send(Buffer.concat([cipher.update(challenge), cipher.final()]))
  assert.equal((await take(4)).readUInt32BE(), 0, "VNC authentication failed")
  socket.send(Buffer.from([1]))
  const init = await take(24)
  await take(init.readUInt32BE(20))
  socket.send(Buffer.from([2, 0, 0, 1, 0, 0, 0, 0]))
  return {
    socket,
    get closed() {
      return closed
    },
    pointer(x: number, y: number, buttons = 0) {
      const data = Buffer.from([5, buttons, 0, 0, 0, 0])
      data.writeUInt16BE(x, 2)
      data.writeUInt16BE(y, 4)
      socket.send(data)
    },
    key(keysym: number, down: boolean) {
      const data = Buffer.alloc(8)
      data[0] = 4
      data[1] = Number(down)
      data.writeUInt32BE(keysym, 4)
      socket.send(data)
    },
  }
}
