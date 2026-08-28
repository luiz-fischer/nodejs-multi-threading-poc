import express, { type ErrorRequestHandler, type Request, type RequestHandler, type Response } from 'express'
import { createHash } from 'node:crypto'
import { context as otelContext, SpanStatusCode, trace } from '@opentelemetry/api'
import { isMainThread, threadId } from 'node:worker_threads'
import process from 'node:process'

import {
  ALL_ENVS,
  APP_NAME,
  APP_VERSION,
  DEFAULT_PORT,
  HASH_ALGORITHM,
  HASH_ENCODING,
  MAX_HASH_PAYLOAD_LENGTH
} from './const.js'
import { hashWithPool, piscina } from './pool.js'
import { runWorker } from './worker.js'
import { getTelemetrySnapshot, shutdownTelemetry } from './instrumentation.js'
import { createUuidV7, getRequestContext, runWithRequestContext } from './track-context.js'
import type { HashRequestBody } from './types.js'

const app = express()

const tracer = trace.getTracer(APP_NAME, APP_VERSION)

const requestContextMiddleware: RequestHandler = (req, res, next) => {
  const requestContext = {
    trackId: createUuidV7(),
    startedAt: process.hrtime.bigint()
  }
  const span = tracer.startSpan(`request ${req.method} ${req.path}`, {
    attributes: {
      'app.track_id': requestContext.trackId,
      'http.method': req.method,
      'http.route': req.path
    }
  })
  let ended = false

  res.setHeader('x-track-id', requestContext.trackId)
  span.addEvent('request.start', { 'app.track_id': requestContext.trackId })

  const endRequest = () => {
    if (ended) return
    ended = true
    const durationMs = Number(process.hrtime.bigint() - requestContext.startedAt) / 1e6
    span.setAttribute('http.status_code', res.statusCode)
    span.setAttribute('app.request.duration_ms', durationMs)
    span.addEvent('request.end', {
      'app.track_id': requestContext.trackId,
      'http.status_code': res.statusCode
    })
    if (res.statusCode >= 500) {
      span.setStatus({ code: SpanStatusCode.ERROR })
    }
    span.end()
  }

  res.once('finish', endRequest)
  res.once('close', endRequest)

  const requestSpanContext = trace.setSpan(otelContext.active(), span)
  runWithRequestContext(requestContext, () => {
    otelContext.with(requestSpanContext, next)
  })
}

app.use(requestContextMiddleware)

app.use(express.json({ limit: '1mb' }))

app.get('/non-blocking/', (_req: Request, res: Response) => {
  res.status(200).send('This page is non-blocking')
})

app.get('/telemetry/resources', async (_req: Request, res: Response, next) => {
  try {
    res.json(await getTelemetrySnapshot())
  } catch (error) {
    next(error)
  }
})

// Single-thread comparison: the hash is calculated on the main event loop.
app.post('/api/singlethread/hash', async (req: Request<unknown, unknown, Partial<HashRequestBody>>, res: Response, next) => {
  const { text } = req.body

  if (!isValidHashText(text)) {
    res.status(400).json({ error: 'The "text" field must be a string with at most 1 MB' })
    return
  }

  try {
    const hash = createHash(HASH_ALGORITHM).update(text, HASH_ENCODING).digest('hex')
    res.json({
      hash,
      execution: {
        mode: 'single-thread',
        isMainThread,
        threadId,
        pid: process.pid,
        trackId: getRequestContext()?.trackId ?? createUuidV7()
      }
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/pool/hash', async (req: Request<unknown, unknown, Partial<HashRequestBody>>, res: Response, next) => {
  if (!isValidHashText(req.body.text)) {
    res.status(400).json({ error: 'The "text" field must be a string with at most 1 MB' })
    return
  }

  try {
    const result = await hashWithPool(req.body.text)
    res.json(result)
  } catch (error) {
    next(error)
  }
})

app.post('/api/hash', async (req: Request<unknown, unknown, Partial<HashRequestBody>>, res: Response, next) => {
  if (!isValidHashText(req.body.text)) {
    res.status(400).json({ error: 'The "text" field must be a string with at most 1 MB' })
    return
  }

  try {
    const hash = await runWorker({ payload: req.body.text })
    res.json(hash)
  } catch (error) {
    next(error)
  }
})

function isValidHashText(text: unknown): text is string {
  return typeof text === 'string' && text.length <= MAX_HASH_PAYLOAD_LENGTH
}


const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  const message = error instanceof Error ? error.message : 'Internal server error'
  res.status(500).json({ error: message })
}

app.use(errorHandler)

const port = Number(ALL_ENVS.PORT ?? DEFAULT_PORT)
const server = app.listen(port, () => {
  console.log(`App listening on port ${port}`)
})

let shuttingDown = false

async function shutdown(exitCode = 0): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true

  try {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
    }

    await piscina.destroy()
    await shutdownTelemetry()
  } catch (error) {
    console.error('Error during shutdown:', error)
    exitCode = 1
  }

  process.exitCode = exitCode
}

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use`)
  } else {
    console.error('Server error:', error)
  }
  void shutdown(1)
})

process.once('SIGTERM', () => void shutdown())
process.once('SIGINT', () => void shutdown())
