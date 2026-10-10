'use strict'
// Inert stand-in for `codex app-server`: speaks just enough of the newline-delimited JSON-RPC
// stdio protocol for Orca to open a structured thread and deliver a turn, records what it
// received in ORCA_E2E_INERT_AGENT_LEDGER, and never touches the network or a model.

const { appendFileSync } = require('node:fs')
const { randomUUID } = require('node:crypto')
const readline = require('node:readline')

const LEDGER = process.env.ORCA_E2E_INERT_AGENT_LEDGER
const MODEL = 'inert-model'
const REPLY_TEXT = 'Inert fixture: prompt received.'

function record(event, fields) {
  if (!LEDGER) {
    return
  }
  // Synchronous so a ledger line exists before the host can observe the matching response.
  appendFileSync(
    LEDGER,
    `${JSON.stringify({ event, at: new Date().toISOString(), pid: process.pid, ...fields })}\n`
  )
}

const args = process.argv.slice(2)
if (args[0] === '--version' || args[0] === '-V') {
  process.stdout.write('codex-cli 0.0.0-inert\n')
  process.exit(0)
}
if (args[0] !== 'app-server') {
  process.stderr.write(`inert codex fixture only serves \`app-server\`, got: ${args.join(' ')}\n`)
  process.exit(64)
}

record('spawn', {
  argv: args,
  cwd: process.cwd(),
  // Present only on a structured-session spawn; lets a reader tell those from other app-server uses.
  spawnToken: process.env.ORCA_AGENT_SESSION_SPAWN_TOKEN ?? null
})

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

function notify(method, params) {
  send({ method, params })
}

const threads = new Map()

function threadResult(threadId) {
  return {
    thread: { id: threadId, turns: [] },
    model: MODEL,
    reasoningEffort: 'medium'
  }
}

function textOf(input) {
  return Array.isArray(input)
    ? input.filter((entry) => entry && entry.type === 'text').map((entry) => entry.text)
    : []
}

/** Plays a completed turn: echo of the user message (which settles the send), one reply, done. */
function playTurn(threadId, turnId, params) {
  notify('turn/started', {
    threadId,
    turn: { id: turnId, status: 'inProgress', items: [] }
  })
  notify('item/completed', {
    threadId,
    turnId,
    item: {
      type: 'userMessage',
      id: randomUUID(),
      ...(typeof params.clientUserMessageId === 'string'
        ? { clientId: params.clientUserMessageId }
        : {}),
      content: textOf(params.input).map((text) => ({ type: 'text', text }))
    }
  })
  const replyId = randomUUID()
  notify('item/started', {
    threadId,
    turnId,
    item: { type: 'agentMessage', id: replyId, text: '' }
  })
  notify('item/agentMessage/delta', {
    threadId,
    turnId,
    itemId: replyId,
    delta: REPLY_TEXT
  })
  notify('item/completed', {
    threadId,
    turnId,
    item: { type: 'agentMessage', id: replyId, text: REPLY_TEXT }
  })
  notify('turn/completed', {
    threadId,
    turn: { id: turnId, status: 'completed', items: [], error: null }
  })
}

const handlers = {
  initialize: () => ({
    userAgent: 'orca_desktop/0.0.0 (inert codex fixture)',
    platformFamily: process.platform === 'win32' ? 'windows' : 'unix',
    platformOs: process.platform
  }),
  'thread/start': () => {
    const threadId = randomUUID()
    threads.set(threadId, true)
    return threadResult(threadId)
  },
  'thread/resume': (params) => {
    const threadId = typeof params.threadId === 'string' ? params.threadId : randomUUID()
    threads.set(threadId, true)
    return threadResult(threadId)
  },
  'thread/read': (params) => ({ thread: { id: params.threadId, turns: [] } }),
  'thread/turns/list': () => ({ data: [], nextCursor: null }),
  'thread/items/list': () => ({ data: [], nextCursor: null }),
  'thread/archive': () => ({}),
  'turn/interrupt': () => ({}),
  'model/list': () => ({
    data: [
      {
        id: MODEL,
        model: MODEL,
        displayName: 'Inert Model',
        hidden: false,
        supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Inert' }],
        defaultReasoningEffort: 'medium',
        isDefault: true
      }
    ],
    nextCursor: null
  }),
  'turn/start': (params, after) => {
    const threadId = params.threadId
    if (!threads.has(threadId)) {
      throw Object.assign(new Error(`unknown thread ${threadId}`), {
        code: -32602
      })
    }
    const turnId = randomUUID()
    record('turn-start', {
      threadId,
      turnId,
      clientUserMessageId: params.clientUserMessageId ?? null,
      inputTexts: textOf(params.input)
    })
    after(() => playTurn(threadId, turnId, params))
    return {
      turn: { id: turnId, status: 'inProgress', items: [], error: null }
    }
  }
}

function handleLine(line) {
  if (!line.trim()) {
    return
  }
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  // Notifications (`initialized`) and responses to server requests need no reply.
  if (!message || typeof message.method !== 'string' || message.id === undefined) {
    return
  }
  const handler = handlers[message.method]
  if (!handler) {
    send({
      id: message.id,
      error: {
        code: -32601,
        message: `inert codex fixture: ${message.method} not supported`
      }
    })
    return
  }
  const deferred = []
  try {
    const result = handler(message.params ?? {}, (fn) => deferred.push(fn))
    send({ id: message.id, result })
  } catch (error) {
    send({
      id: message.id,
      error: {
        code: typeof error.code === 'number' ? error.code : -32603,
        message: error.message
      }
    })
  }
  for (const fn of deferred) {
    fn()
  }
}

const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
})
lines.on('line', handleLine)
lines.on('close', () => process.exit(0))
