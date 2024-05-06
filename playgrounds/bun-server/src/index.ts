import type { ServerWebSocket } from "bun"
import wrtc from '@roamhq/wrtc'
import * as Y from 'yjs'
import { WebrtcProvider } from 'y-webrtc';

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

function removeConnRecord(ws: WebSocketConn) {
  const subscribedTopics = getConnRecord(ws).subscribedTopics

  subscribedTopics.forEach(topicName => {
    const subs = topics.get(topicName) || new Set()
    subs.delete(ws)
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

const ydocs = new Map<string, Y.Doc>()
const initWebrtcProvider = (topic: string) => {
  if (ydocs.get(topic))
    return ydocs.get(topic)

  console.log('init webrtc provider', topic)
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
    }
  })

  ydoc.on('update', () => {
    console.log('update', ydoc.getArray('state').toJSON())
  })

  ydoc.on('destroy', () => {
    provider.destroy()
  })


  return ydoc
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
      const messageData = JSON.parse(message  as any) as WebSocketPayload
      console.log(messageData, 'messageData')
      switch (messageData.type) {
        case 'ping':
          send(ws, { type: 'pong' })
          break
        case 'publish': {
          const { topic } = messageData
          const subscribers = topics.get(topic)
          if (subscribers) {
            const size = subscribers.size
            subscribers.forEach((subscriber) => {
              send(subscriber, {
                ...messageData,
                clients: size,
              })
            })
          }
        }
          break
        case 'subscribe':
          (messageData.topics || []).forEach((topicName) => {
            const { subscribedTopics } = getConnRecord(ws)
            subscribedTopics.add(topicName)

            const topic = topics.get(topicName) || new Set()
            topic.add(ws)
            topics.set(topicName, topic)

            initWebrtcProvider(topicName)
          })
          break
        case 'unsubscribe':
          (messageData.topics || []).forEach((topicName) => {
            const subs = topics.get(topicName)

            subs?.delete(ws)
          })
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
       
      removeConnRecord(ws)
    }, // a socket is closed
    drain(ws) { }, // the socket is ready to receive more data
  }
})

console.log('server started on port 3000')