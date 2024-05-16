import http from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import wrtc from '@roamhq/wrtc'
import * as Y from 'yjs'
import { WebrtcProvider } from 'y-webrtc'

Object.assign(global, { WebSocket })

const wsReadyStateConnecting = 0
const wsReadyStateOpen = 1

interface WSSubscribePayload {
  type: 'subscribe'
  topics: string[]
}
interface WSUnsubscribePayload {
  type: 'unsubscribe'
  topics: string[]
}
interface WSPublishPayload {
  type: 'publish'
  topic: string
}

interface WSPingPayload {
  type: 'ping'
}

type WebSocketPayload =
  | WSSubscribePayload
  | WSUnsubscribePayload
  | WSPublishPayload
  | WSPingPayload

type WebSocketConn = WebSocket

interface ConnRecord {
  subscribedTopics: Set<string>
  pongReceived: boolean
}
const topics = new Map<string, Set<WebSocketConn>>()
const ydocs = new Map<string, Y.Doc>()

const connRecords = new Map<WebSocketConn, ConnRecord>()

function getConnRecord(ws: WebSocketConn) {
  if (!connRecords.get(ws))
    connRecords.set(ws, { pongReceived: false, subscribedTopics: new Set() })

  return connRecords.get(ws)!
}
function setConnRecord(ws: WebSocketConn, record: Partial<ConnRecord>) {
  connRecords.set(ws, {
    ...connRecords.get(ws) as any,
    ...record,
  })
}
function removeConnRecord(ws: WebSocketConn) {
  const subscribedTopics = getConnRecord(ws).subscribedTopics

  subscribedTopics.forEach((topicName) => {
    const subs = topics.get(topicName) || new Set()
    subs.delete(ws)
    console.log(subs.size, 'subs.size')
    if (subs.size <= 1) {
      topics.delete(topicName)
      const ydoc = ydocs.get(topicName)
      ydoc?.destroy()
      ydocs.delete(topicName)
    }
  })
  subscribedTopics.clear()
  connRecords.delete(ws)
}

function startPingPong(ws: WebSocketConn) {
  const pingInterval = setInterval(() => {
    const { pongReceived } = getConnRecord(ws)
    if (!pongReceived) {
      ws.close()
      clearInterval(pingInterval)
    }
    else {
      setConnRecord(ws, { pongReceived: false })
      try {
        ws.ping()
      }
      catch (e) {
        ws.close()
      }
    }
  }, 1000 * 60)
}

function send(conn: WebSocketConn, message: any) {
  if (conn.readyState !== wsReadyStateConnecting && conn.readyState !== wsReadyStateOpen)
    conn.close()

  try {
    conn.send(JSON.stringify(message))
  }
  catch (e) {
    conn.close()
  }
}

function initWebrtcProvider(topic: string) {
  if (ydocs.get(topic))
    return ydocs.get(topic)

  const ydoc = new Y.Doc()
  ydocs.set(topic, ydoc)
  const provider = new WebrtcProvider(topic, ydoc, {
    signaling: ['ws://localhost:3000'],

    peerOpts: {
      wrtc: {
        RTCSessionDescription: wrtc.RTCSessionDescription,
        RTCPeerConnection: wrtc.RTCPeerConnection,
        RTCIceCandidate: wrtc.RTCIceCandidate,
      },
    },
  })

  ydoc.on('update', () => {
  })

  ydoc.on('destroy', () => {
    provider.destroy()
  })

  return ydoc
}

const wss = new WebSocketServer({
  port: 3000,
  perMessageDeflate: {
    zlibDeflateOptions: {
      // See zlib defaults.
      chunkSize: 1024,
      memLevel: 7,
      level: 3,
    },
    zlibInflateOptions: {
      chunkSize: 10 * 1024,
    },
    // Other options settable:
    clientNoContextTakeover: true, // Defaults to negotiated value.
    serverNoContextTakeover: true, // Defaults to negotiated value.
    serverMaxWindowBits: 10, // Defaults to negotiated value.
    // Below options specified as default values.
    concurrencyLimit: 10, // Limits zlib concurrency for perf.
    threshold: 1024, // Size (in bytes) below which messages
    // should not be compressed if context takeover is disabled.

  },
})

wss.on('connection', (ws) => {
  setConnRecord(ws, {
    pongReceived: true,
    subscribedTopics: new Set(),
  })

  startPingPong(ws)

  ws.on('message', (data) => {
    const message = JSON.parse(data.toString()) as WebSocketPayload
    switch (message.type) {
      case 'subscribe':
        (message.topics || []).forEach((topicName) => {
          if (typeof topicName === 'string') {
            initWebrtcProvider(topicName)

            const subscribedTopics = getConnRecord(ws).subscribedTopics

            const topic = topics.get(topicName) || new Set()
            topic.add(ws)
            topics.set(topicName, topic)

            subscribedTopics.add(topicName)
          }
        })
        break
      case 'unsubscribe':
        (message.topics || []).forEach((topicName) => {
          const subs = topics.get(topicName)

          subs?.delete(ws)
        })
        break
      case 'publish': {
        const { topic } = message
        const subscribers = topics.get(topic)
        if (subscribers) {
          const size = subscribers.size
          subscribers.forEach((subscriber) => {
            send(subscriber, {
              ...message,
              clients: size,
            })
          })
        }
      }
        break
      case 'ping':
        setConnRecord(ws, { pongReceived: true })
        break
    }
  })

  ws.on('close', () => {
    removeConnRecord(ws)
  })
})

// eslint-disable-next-line no-console
console.log('Server started at ws://localhost:3000')
