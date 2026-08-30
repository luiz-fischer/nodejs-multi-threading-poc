import process from 'node:process'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  BULLMQ_STATUS_POLL_INTERVAL_MS,
  STRESS_DEFAULT_CONCURRENCY,
  STRESS_DEFAULT_PAYLOAD_BYTES,
  STRESS_DEFAULT_REQUESTS,
  STRESS_DEFAULT_TIMEOUT_MS
} from '../dist/const.js'

const baseUrl = process.env.BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? '3001'}`
const totalRequests = Number(process.env.STRESS_REQUESTS ?? STRESS_DEFAULT_REQUESTS)
const concurrency = Number(process.env.STRESS_CONCURRENCY ?? STRESS_DEFAULT_CONCURRENCY)
const payloadBytes = Number(process.env.STRESS_PAYLOAD_BYTES ?? STRESS_DEFAULT_PAYLOAD_BYTES)
const requestTimeoutMs = Number(process.env.STRESS_TIMEOUT_MS ?? STRESS_DEFAULT_TIMEOUT_MS)
const outputPath = resolve(process.env.STRESS_OUTPUT ?? `logs/stress-results-${Date.now()}.json`)

const allCases = [
  { name: 'single-thread', path: '/api/singlethread/hash', mode: 'single-thread' },
  { name: 'worker-thread', path: '/api/raw-worker/hash', mode: 'worker-thread', queued: true },
  { name: 'piscina', path: '/api/hash', mode: 'piscina' }
]
const selectedMode = process.env.STRESS_MODE ?? 'all'
const cases = selectedMode === 'all'
  ? allCases
  : allCases.filter((testCase) => testCase.mode === selectedMode)

if (cases.length === 0) {
  throw new Error(`Unknown STRESS_MODE: ${selectedMode}`)
}

if (!Number.isInteger(totalRequests) || totalRequests < 1) {
  throw new Error('STRESS_REQUESTS must be a positive integer')
}

if (!Number.isInteger(concurrency) || concurrency < 1) {
  throw new Error('STRESS_CONCURRENCY must be a positive integer')
}

if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
  throw new Error('STRESS_TIMEOUT_MS must be a positive integer')
}

const payload = 'x'.repeat(payloadBytes)
const body = JSON.stringify({ text: payload })
const expectedPayloadBytes = Buffer.byteLength(payload, 'utf8')

function isUuidV7(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function percentile(values, fraction) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) * fraction)]
}

function formatMs(value) {
  return `${value.toFixed(2)} ms`
}

function calculateExpectedHash(text, rounds) {
  let digest = ''
  for (let round = 0; round < rounds; round += 1) {
    digest = createHash('sha256').update(text, 'utf8').digest('hex')
  }
  return digest
}

function calculateExpectedFingerprint(rounds, payloadHash) {
  const fingerprintSource = JSON.stringify({
    algorithm: 'sha256',
    encoding: 'utf8',
    rounds,
    payloadBytes: expectedPayloadBytes,
    payloadHash
  })

  return createHash('sha256')
    .update(fingerprintSource, 'utf8')
    .digest('hex')
}

async function waitForServer() {
  const deadline = Date.now() + 10_000
  let lastError = 'health check did not return 200'

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/non-blocking/`)
      if (response.ok) return
      lastError = `health check returned HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }

    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  throw new Error(`Unable to connect to ${baseUrl}. Start the API first. Last error: ${lastError}`)
}

async function request(path, method = 'POST', additionalHeaders = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs)
  const startedAt = performance.now()

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: method === 'POST'
        ? { 'content-type': 'application/json', ...additionalHeaders }
        : additionalHeaders,
      body: method === 'POST' ? body : undefined,
      signal: controller.signal
    })
    const contentType = response.headers.get('content-type') ?? ''
    const data = contentType.includes('application/json')
      ? await response.json()
      : await response.text()

    if (!response.ok) {
      throw new Error(`${response.status}: ${JSON.stringify(data)}`)
    }

    return {
      data,
      durationMs: performance.now() - startedAt,
      statusCode: response.status
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${method} ${path} timed out after ${requestTimeoutMs} ms`)
    }

    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function waitForQueuedResult(submission, startedAt) {
  if (!submission || typeof submission.statusUrl !== 'string' || !submission.jobId) {
    throw new Error(`Invalid BullMQ submission response: ${JSON.stringify(submission)}`)
  }

  const deadline = startedAt + requestTimeoutMs
  while (performance.now() < deadline) {
    const result = await request(submission.statusUrl, 'GET')

    if (result.statusCode === 200 && result.data?.execution) {
      return {
        data: result.data,
        durationMs: performance.now() - startedAt
      }
    }

    if (result.statusCode !== 202) {
      throw new Error(`Unexpected BullMQ job status response: ${result.statusCode}`)
    }

    await new Promise((resolve) => setTimeout(resolve, BULLMQ_STATUS_POLL_INTERVAL_MS))
  }

  throw new Error(`BullMQ job ${submission.jobId} timed out after ${requestTimeoutMs} ms`)
}

async function executeTestRequest(testCase) {
  const startedAt = performance.now()
  const submission = await request(testCase.path)
  if (!testCase.queued) return submission
  return waitForQueuedResult(submission.data, startedAt)
}

async function verifyBullMqIdempotency(testCase) {
  if (!testCase.queued) return

  const first = await request(testCase.path)
  const idempotencyKey = first.data?.trackId
  if (!isUuidV7(idempotencyKey)) {
    throw new Error(`BullMQ submission returned an invalid trackId: ${JSON.stringify(first.data)}`)
  }

  const duplicate = await request(testCase.path, 'POST', {
    'idempotency-key': idempotencyKey
  })

  if (first.data.jobId !== duplicate.data?.jobId || duplicate.data?.deduplicated !== true) {
    throw new Error(
      `BullMQ idempotency validation failed: ${JSON.stringify({ first: first.data, duplicate: duplicate.data })}`
    )
  }

  await waitForQueuedResult(first.data, performance.now())
}

async function runCase(testCase) {
  const durations = []
  const probeDurations = []
  const threadIds = new Set()
  const trackIds = new Set()
  const processIds = new Set()
  const hashRounds = new Set()
  let expectedHash
  let expectedFingerprint
  let workloadProof
  const violations = []
  const errors = []
  const resourceSnapshots = []
  let nextRequest = 0
  let probing = true

  const probe = (async () => {
    while (probing) {
      try {
        const result = await request('/non-blocking/', 'GET')
        probeDurations.push(result.durationMs)
      } catch {
        // The probe is diagnostic and must not hide the load-test result.
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  })()

  const resourceMonitor = (async () => {
    while (probing) {
      try {
        const result = await request('/telemetry/resources', 'GET')
        resourceSnapshots.push(result.data)
      } catch {
        // Resource monitoring is diagnostic and must not hide load-test errors.
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  })()

  const startedAt = performance.now()
  const clients = Array.from({ length: Math.min(concurrency, totalRequests) }, async () => {
    while (true) {
      const requestNumber = nextRequest++
      if (requestNumber >= totalRequests) return

      try {
        const result = await executeTestRequest(testCase)
        const execution = result.data.execution
        const workload = result.data.workload

        durations.push(result.durationMs)

        if (!execution || execution.mode !== testCase.mode) {
          violations.push({ requestNumber, reason: 'unexpected execution mode', execution })
          continue
        }

        threadIds.add(execution.threadId)
        processIds.add(execution.pid)
        trackIds.add(execution.trackId)
        hashRounds.add(execution.hashRounds)

        if (testCase.mode === 'single-thread' &&
            (execution.isMainThread !== true || execution.threadId !== 0)) {
          violations.push({ requestNumber, reason: 'single-thread endpoint left the main thread', execution })
        }

        if (testCase.mode !== 'single-thread' &&
            (execution.isMainThread !== false || execution.threadId <= 0)) {
          violations.push({ requestNumber, reason: 'worker endpoint did not run on a worker thread', execution })
        }

        if (!isUuidV7(execution.trackId)) {
          violations.push({ requestNumber, reason: 'missing or invalid UUIDv7 trackId', execution })
        }

        if (!Number.isInteger(execution.hashRounds) || execution.hashRounds < 1) {
          violations.push({ requestNumber, reason: 'invalid hashRounds value', execution })
        }

        expectedHash ??= calculateExpectedHash(payload, execution.hashRounds)
        expectedFingerprint ??= calculateExpectedFingerprint(execution.hashRounds, expectedHash)

        if (result.data.hash !== expectedHash) {
          violations.push({ requestNumber, reason: 'hash result differs from the shared workload', execution })
        }

        const validWorkload = workload &&
          workload.algorithm === 'sha256' &&
          workload.encoding === 'utf8' &&
          workload.rounds === execution.hashRounds &&
          workload.payloadBytes === expectedPayloadBytes &&
          workload.inputFingerprint === expectedFingerprint

        if (!validWorkload) {
          violations.push({
            requestNumber,
            reason: 'workload input or fingerprint differs from the shared contract',
            workload,
            expectedFingerprint
          })
          continue
        }

        workloadProof ??= workload

        if (JSON.stringify(workload) !== JSON.stringify(workloadProof)) {
          violations.push({ requestNumber, reason: 'workload proof changed between requests', workload })
        }
      } catch (error) {
        errors.push({ requestNumber, message: error instanceof Error ? error.message : String(error) })
      }
    }
  })

  await Promise.all(clients)
  const elapsedMs = performance.now() - startedAt
  probing = false
  await probe
  await resourceMonitor

  if (errors.length > 0) {
    throw new Error(`${testCase.name}: ${errors.length} request(s) failed. First error: ${errors[0].message}`)
  }

  if (violations.length > 0) {
    throw new Error(`${testCase.name}: execution proof failed. First violation: ${JSON.stringify(violations[0])}`)
  }

  if (trackIds.size !== durations.length) {
    throw new Error(`${testCase.name}: trackId is not unique per successful request (${trackIds.size}/${durations.length})`)
  }

  if (hashRounds.size !== 1) {
    throw new Error(`${testCase.name}: inconsistent hashRounds across responses`)
  }

  if (testCase.mode !== 'single-thread' && threadIds.size < 2) {
    throw new Error(`${testCase.name}: only one worker thread observed; increase STRESS_REQUESTS or STRESS_CONCURRENCY`)
  }

  const resourceMetric = (name) => resourceSnapshots
    .flatMap((snapshot) => snapshot.metrics?.[name] ?? [])
    .filter((value) => Number.isFinite(value))
    .map(Number)

  const resourcePeak = (name) => Math.max(0, ...resourceMetric(name))

  const poolQueueSize = resourcePeak('app.pool.queue.size')
  const jobQueueWaiting = resourcePeak('app.job_queue.waiting')

  return {
    endpoint: testCase.path,
    requests: totalRequests,
    concurrency,
    payload: `${payloadBytes} bytes`,
    totalMs: elapsedMs,
    throughput: totalRequests / (elapsedMs / 1000),
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99),
    probeP95Ms: percentile(probeDurations, 0.95),
    trackIds: trackIds.size,
    hashRounds: [...hashRounds][0],
    hash: expectedHash,
    workload: workloadProof,
    resourceSamples: resourceSnapshots.length,
    resourcePeaks: {
      eventLoopLagSeconds: resourcePeak('app.event_loop.lag'),
      heapUsedBytes: resourcePeak('app.process.heap.used'),
      maxRssBytes: resourcePeak('app.process.memory.max_rss'),
      userCpuSeconds: resourcePeak('app.process.cpu.user'),
      poolQueueSize,
      jobQueueWaiting,
      queueSize: Math.max(poolQueueSize, jobQueueWaiting)
    },
    threadIds: [...threadIds].sort((a, b) => a - b),
    processIds: [...processIds]
  }
}

console.log(`Stress test: ${baseUrl}`)
console.log(`Requests=${totalRequests}, concurrency=${concurrency}, payload=${payloadBytes} bytes`)
console.log('Each response is checked for execution context, shared workload input and payload fingerprint.')

await waitForServer()

const results = []
try {
  for (const testCase of cases) {
    await verifyBullMqIdempotency(testCase)
    const result = await runCase(testCase)
    results.push(result)
    console.log(`\n${testCase.name} ${testCase.path}`)
    console.log(`  hash rounds: ${result.hashRounds}`)
    console.log(`  throughput: ${result.throughput.toFixed(2)} req/s`)
    console.log(`  p50/p95/p99: ${formatMs(result.p50Ms)} / ${formatMs(result.p95Ms)} / ${formatMs(result.p99Ms)}`)
    console.log(`  /non-blocking/ probe p95: ${formatMs(result.probeP95Ms)}`)
    console.log(`  OTel resource samples: ${result.resourceSamples}`)
    console.log(`  OTel peaks: heap=${(result.resourcePeaks.heapUsedBytes / 1024 / 1024).toFixed(2)} MB, ` +
      `RSS=${(result.resourcePeaks.maxRssBytes / 1024 / 1024).toFixed(2)} MB, ` +
      `event-loop=${(result.resourcePeaks.eventLoopLagSeconds * 1000).toFixed(2)} ms, ` +
      `CPU=${result.resourcePeaks.userCpuSeconds.toFixed(2)} s, ` +
      `queue=${result.resourcePeaks.queueSize}`)
    console.log(`  process IDs: ${result.processIds.join(', ') || 'none'}`)
    console.log(`  worker thread count: ${result.threadIds.length}`)
    console.log(`  track IDs: ${result.trackIds}/${result.requests}`)
    console.log(`  workload fingerprint: ${result.workload.inputFingerprint}`)
  }

  const workloadContracts = new Set(results.map((result) => JSON.stringify({
    hash: result.hash,
    workload: result.workload
  })))

  if (workloadContracts.size !== 1) {
    throw new Error('The processing modes did not execute the same workload contract')
  }
} catch (error) {
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, JSON.stringify({
    status: 'failed',
    generatedAt: new Date().toISOString(),
    baseUrl,
    totalRequests,
    concurrency,
    payloadBytes,
    requestTimeoutMs,
    results,
    error: error instanceof Error ? error.message : String(error)
  }, null, 2))
  throw error
}

console.log('\nComparison')
console.table(results.map(({ endpoint, hashRounds, throughput, p50Ms, p95Ms, p99Ms, probeP95Ms, resourcePeaks, threadIds }) => ({
  endpoint,
  hashRounds,
  throughput: `${throughput.toFixed(2)} req/s`,
  p50: formatMs(p50Ms),
  p95: formatMs(p95Ms),
  p99: formatMs(p99Ms),
  probeP95: formatMs(probeP95Ms),
  heapPeak: `${(resourcePeaks.heapUsedBytes / 1024 / 1024).toFixed(2)} MB`,
  rssPeak: `${(resourcePeaks.maxRssBytes / 1024 / 1024).toFixed(2)} MB`,
  eventLoopPeak: `${(resourcePeaks.eventLoopLagSeconds * 1000).toFixed(2)} ms`,
  threads: threadIds.length === 0 ? 'main' : threadIds.length
})))

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, JSON.stringify({
  status: 'completed',
  generatedAt: new Date().toISOString(),
  baseUrl,
  totalRequests,
  concurrency,
  payloadBytes,
  requestTimeoutMs,
  results
}, null, 2))
console.log(`\nJSON report: ${outputPath}`)
