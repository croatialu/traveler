import type { ServerWebSocket } from "bun"

const wsReadyStateConnecting = 0
const wsReadyStateOpen = 1


interface WSSubscribePayload {
  type: 'subscribe'
}
interface WSUnsubscribePayload {
  type: 'unsubscribe'
}
interface WSPublishPayload {
  type: 'publish'
  topic: string
  data: any
}

interface WSPingPayload {
  type: 'ping'
}

type WebSocketPayload =
  | WSSubscribePayload
  | WSUnsubscribePayload
  | WSPublishPayload
  | WSPingPayload

type WebSocketConn = ServerWebSocket<WebSocketPayload>

interface ConnRecord {
  subscribedTopics: Set<string>
  pongReceived: boolean
}

const connRecords = new Map<WebSocketConn, ConnRecord>()


const getConnRecord = (ws: WebSocketConn) => {
  return connRecords.get(ws) || { pongReceived: false, subscribedTopics: new Set() }
}
const setConnRecord = (ws: WebSocketConn, record: Partial<ConnRecord>) => {
  connRecords.set(ws, {
    ...connRecords.get(ws) as any,
    ...record
  })
}
const removeConnRecord = (ws: WebSocketConn) => {
  connRecords.delete(ws)
}



const topics = new Map<string, Set<WebSocketConn>>()

const startPingPong = (ws: WebSocketConn) => {
  const pingInterval = setInterval(() => {
    const { pongReceived } = getConnRecord(ws)
    if (!pongReceived) {
      ws.close()
      clearInterval(pingInterval)
    } else {
      setConnRecord(ws, { pongReceived: false })
      try {
        ws.ping()
      } catch (e) {
        ws.close()
      }
    }
  }, 1000 * 60)
}



const send = (conn: WebSocketConn, message: any) => {
  if (conn.readyState !== wsReadyStateConnecting && conn.readyState !== wsReadyStateOpen) {
    conn.close()
  }
  try {
    conn.send(JSON.stringify(message))
  } catch (e) {
    conn.close()
  }
}



Bun.serve<WebSocketPayload>({
  port: 3000,
  fetch(req, server) {
    // upgrade the request to a WebSocket
    if (server.upgrade(req))
      return // do not return a Response

    return new Response('hello!')
  },
  websocket: {
    message(ws, message) {
      const messageData = ws.data

      switch (messageData.type) {
        case 'ping':
          send(ws, { type: 'pong' })
          break
        case 'publish':
          break
        case 'subscribe':
          break
        case 'unsubscribe':
          break
      }


    }, // a message is received
    open(ws) {
      setConnRecord(ws, {
        subscribedTopics: new Set(),
        pongReceived: true
      })
      startPingPong(ws)
    }, // a socket is opened
    pong(ws) {
      setConnRecord(ws, { pongReceived: true })
    },
    close(ws, code, message) {
      const { subscribedTopics } = getConnRecord(ws)
      subscribedTopics.forEach(topicName => {
        const subs = topics.get(topicName) || new Set()
        subs.delete(ws)
        if (subs.size === 0) {
          topics.delete(topicName)
        }
      })

      subscribedTopics.clear()
      removeConnRecord(ws)
    }, // a socket is closed
    drain(ws) { }, // the socket is ready to receive more data
  }
})
