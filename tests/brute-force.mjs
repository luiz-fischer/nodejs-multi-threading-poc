import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import {
  BULLMQ_STATUS_POLL_INTERVAL_MS,
  BRUTE_FORCE_DEFAULT_CONCURRENCY_STEPS,
  BRUTE_FORCE_DEFAULT_CPU_LIMIT,
  BRUTE_FORCE_DEFAULT_MAX_ERROR_RATE_PERCENT,
  BRUTE_FORCE_DEFAULT_MEMORY_LIMIT_MB,
  BRUTE_FORCE_DEFAULT_MONITOR_INTERVAL_MS,
  BRUTE_FORCE_DEFAULT_REQUEST_TIMEOUT_MS,
  BRUTE_FORCE_DEFAULT_RSS_LIMIT_PERCENT,
  BRUTE_FORCE_DEFAULT_SETTLE_MS,
  BRUTE_FORCE_DEFAULT_STAGE_DURATION_MS,
  STRESS_DEFAULT_PAYLOAD_BYTES
} from '../dist/const.js'

const scenarios = {
  'single-thread': {
    mode: 'single-thread',
    endpoint: '/api/singlethread/hash',
    defaultPort: 3011
  },
  'worker-thread': {
    mode: 'worker-thread',
    endpoint: '/api/raw-worker/hash',
    defaultPort: 3012,
    queued: true
  },
  piscina: {
    mode: 'piscina',
    endpoint: '/api/hash',
    defaultPort: 3013
  }
}

const selectedMode = process.argv[2] ?? process.env.BRUTE_FORCE_MODE ?? 'worker-thread'
const scenario = scenarios[selectedMode]

if (!scenario) {
  throw new Error(`Unknown BRUTE_FORCE_MODE: ${selectedMode}`)
}

function positiveNumber(name, rawValue, fallback) {
  const value = Number(rawValue ?? fallback)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`)
  }
  return value
}

function nonNegativeNumber(name, rawValue, fallback) {
  const value = Number(rawValue ?? fallback)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`)
  }
  return value
}

function concurrencySteps(rawValue) {
  if (!rawValue) return [...BRUTE_FORCE_DEFAULT_CONCURRENCY_STEPS]

  const values = rawValue
    .split(',')
    .map((value) => Number(value.trim()))

  if (values.length === 0 || values.some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new Error('BRUTE_FORCE_CONCURRENCY_STEPS must contain positive integers separated by commas')
  }

  return [...new Set(values)].sort((left, right) => left - right)
}

const baseUrl = process.env.BASE_URL ?? `http://127.0.0.1:${scenario.defaultPort}`
const steps = concurrencySteps(process.env.BRUTE_FORCE_CONCURRENCY_STEPS)
const stageDurationMs = positiveNumber(
  'BRUTE_FORCE_STAGE_DURATION_MS',
  process.env.BRUTE_FORCE_STAGE_DURATION_MS,
  BRUTE_FORCE_DEFAULT_STAGE_DURATION_MS
)
const requestTimeoutMs = positiveNumber(
  'BRUTE_FORCE_REQUEST_TIMEOUT_MS',
  process.env.BRUTE_FORCE_REQUEST_TIMEOUT_MS,
  BRUTE_FORCE_DEFAULT_REQUEST_TIMEOUT_MS
)
const payloadBytes = positiveNumber(
  'BRUTE_FORCE_PAYLOAD_BYTES',
  process.env.BRUTE_FORCE_PAYLOAD_BYTES,
  STRESS_DEFAULT_PAYLOAD_BYTES
)
const memoryLimitMb = positiveNumber(
  'BRUTE_FORCE_MEMORY_LIMIT_MB',
  process.env.BRUTE_FORCE_MEMORY_LIMIT_MB,
  BRUTE_FORCE_DEFAULT_MEMORY_LIMIT_MB
)
const rssLimitPercent = positiveNumber(
  'BRUTE_FORCE_RSS_LIMIT_PERCENT',
  process.env.BRUTE_FORCE_RSS_LIMIT_PERCENT,
  BRUTE_FORCE_DEFAULT_RSS_LIMIT_PERCENT
)
const maxErrorRatePercent = nonNegativeNumber(
  'BRUTE_FORCE_MAX_ERROR_RATE_PERCENT',
  process.env.BRUTE_FORCE_MAX_ERROR_RATE_PERCENT,
  BRUTE_FORCE_DEFAULT_MAX_ERROR_RATE_PERCENT
)
const cpuLimit = positiveNumber(
  'BRUTE_FORCE_CPU_LIMIT',
  process.env.BRUTE_FORCE_CPU_LIMIT,
  BRUTE_FORCE_DEFAULT_CPU_LIMIT
)
const settleMs = nonNegativeNumber(
  'BRUTE_FORCE_SETTLE_MS',
  process.env.BRUTE_FORCE_SETTLE_MS,
  BRUTE_FORCE_DEFAULT_SETTLE_MS
)
const monitorIntervalMs = positiveNumber(
  'BRUTE_FORCE_MONITOR_INTERVAL_MS',
  process.env.BRUTE_FORCE_MONITOR_INTERVAL_MS,
  BRUTE_FORCE_DEFAULT_MONITOR_INTERVAL_MS
)
const monitorRequestTimeoutMs = Math.min(5_000, requestTimeoutMs)
const rssLimitBytes = memoryLimitMb * 1024 * 1024 * (rssLimitPercent / 100)
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const outputPath = resolve(
  process.env.BRUTE_FORCE_OUTPUT ?? `logs/brute-force-${scenario.mode}-${runId}.json`
)

if (!Number.isSafeInteger(payloadBytes) || payloadBytes > 1_000_000) {
  throw new Error('BRUTE_FORCE_PAYLOAD_BYTES must be an integer between 1 and 1000000')
}

if (rssLimitPercent > 100) {
  throw new Error('BRUTE_FORCE_RSS_LIMIT_PERCENT must not exceed 100')
}

if (maxErrorRatePercent > 100) {
  throw new Error('BRUTE_FORCE_MAX_ERROR_RATE_PERCENT must not exceed 100')
}

const payload = 'x'.repeat(payloadBytes)
const requestBody = JSON.stringify({ text: payload })
const expectedPayloadBytes = Buffer.byteLength(payload, 'utf8')
const allTrackIds = new Set()
const allThreadIds = new Set()
const allProcessIds = new Set()
let expectedHash
let expectedFingerprint
let expectedRounds
let workloadContract

class ValidationError extends Error {}

function isUuidV7(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function percentile(values, fraction) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor((sorted.length - 1) * fraction)]
}

function calculateExpectedHash(rounds) {
  let digest = ''
  for (let round = 0; round < rounds; round += 1) {
    digest = createHash('sha256').update(payload, 'utf8').digest('hex')
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

function describeError(error) {
  if (!(error instanceof Error)) return String(error)
  if (error.cause instanceof Error) return `${error.message}: ${error.cause.message}`
  return error.message
}

async function request(path, options = {}) {
  const {
    method = 'POST',
    timeoutMs = requestTimeoutMs,
    loadControllers,
    headers = {}
  } = options
  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const startedAt = performance.now()

  loadControllers?.add(controller)

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: method === 'POST'
        ? { 'content-type': 'application/json', ...headers }
        : headers,
      body: method === 'POST' ? requestBody : undefined,
      signal: controller.signal
    })
    const contentType = response.headers.get('content-type') ?? ''
    const data = contentType.includes('application/json')
      ? await response.json()
      : await response.text()

    if (!response.ok) {
      const serialized = JSON.stringify(data)
      throw new Error(`HTTP ${response.status}: ${serialized.slice(0, 500)}`)
    }

    return {
      data,
      durationMs: performance.now() - startedAt,
      statusCode: response.status
    }
  } catch (error) {
    if (timedOut) {
      throw new Error(`${method} ${path} timed out after ${timeoutMs} ms`)
    }

    if (controller.signal.aborted) {
      throw new Error(`${method} ${path} was aborted after the stage reached a stop condition`)
    }

    throw error
  } finally {
    clearTimeout(timeout)
    loadControllers?.delete(controller)
  }
}

async function waitForQueuedResult(submission, startedAt, loadControllers) {
  if (!submission || typeof submission.statusUrl !== 'string' || !submission.jobId) {
    throw new ValidationError(`Invalid BullMQ submission response: ${JSON.stringify(submission)}`)
  }

  const deadline = startedAt + requestTimeoutMs
  while (performance.now() < deadline) {
    const remainingMs = Math.max(1, deadline - performance.now())
    const result = await request(submission.statusUrl, {
      method: 'GET',
      timeoutMs: Math.min(requestTimeoutMs, remainingMs),
      loadControllers
    })

    if (result.statusCode === 200 && result.data?.execution) {
      return {
        data: result.data,
        durationMs: performance.now() - startedAt
      }
    }

    if (result.statusCode !== 202) {
      throw new Error(`Unexpected BullMQ job status response: ${result.statusCode}`)
    }

    await delay(BULLMQ_STATUS_POLL_INTERVAL_MS)
  }

  throw new Error(`BullMQ job ${submission.jobId} timed out after ${requestTimeoutMs} ms`)
}

async function executeScenarioRequest(loadControllers) {
  const startedAt = performance.now()
  const submission = await request(scenario.endpoint, { loadControllers })
  if (!scenario.queued) return submission
  return waitForQueuedResult(submission.data, startedAt, loadControllers)
}

async function verifyBullMqIdempotency() {
  if (!scenario.queued) return

  const first = await request(scenario.endpoint)
  const idempotencyKey = first.data?.trackId
  if (!isUuidV7(idempotencyKey)) {
    throw new ValidationError(`BullMQ submission returned an invalid trackId: ${JSON.stringify(first.data)}`)
  }

  const duplicate = await request(scenario.endpoint, {
    headers: {
      'idempotency-key': idempotencyKey
    }
  })

  if (first.data.jobId !== duplicate.data?.jobId || duplicate.data?.deduplicated !== true) {
    throw new ValidationError(
      `BullMQ idempotency validation failed: ${JSON.stringify({ first: first.data, duplicate: duplicate.data })}`
    )
  }

  await waitForQueuedResult(first.data, performance.now())
}

function validateResponse(data, stageTrackIds, stageThreadIds) {
  if (!data || typeof data !== 'object') {
    throw new ValidationError('Response is not a JSON object')
  }

  const execution = data.execution
  const workload = data.workload

  if (!execution || execution.mode !== scenario.mode) {
    throw new ValidationError(`Unexpected execution mode: ${JSON.stringify(execution)}`)
  }

  if (scenario.mode === 'single-thread' &&
      (execution.isMainThread !== true || execution.threadId !== 0)) {
    throw new ValidationError('The single-thread endpoint left the main thread')
  }

  if (scenario.mode !== 'single-thread' &&
      (execution.isMainThread !== false || !Number.isSafeInteger(execution.threadId) || execution.threadId <= 0)) {
    throw new ValidationError('The worker endpoint did not execute on a worker thread')
  }

  if (!isUuidV7(execution.trackId)) {
    throw new ValidationError('The response does not contain a valid UUIDv7 trackId')
  }

  if (allTrackIds.has(execution.trackId)) {
    throw new ValidationError(`Duplicate trackId detected: ${execution.trackId}`)
  }

  if (!Number.isSafeInteger(execution.hashRounds) || execution.hashRounds < 1) {
    throw new ValidationError('The response contains an invalid hashRounds value')
  }

  expectedRounds ??= execution.hashRounds
  if (execution.hashRounds !== expectedRounds) {
    throw new ValidationError(`hashRounds changed from ${expectedRounds} to ${execution.hashRounds}`)
  }

  expectedHash ??= calculateExpectedHash(expectedRounds)
  expectedFingerprint ??= calculateExpectedFingerprint(expectedRounds, expectedHash)

  if (data.hash !== expectedHash) {
    throw new ValidationError('The hash differs from the shared workload result')
  }

  const validWorkload = workload &&
    workload.algorithm === 'sha256' &&
    workload.encoding === 'utf8' &&
    workload.rounds === expectedRounds &&
    workload.payloadBytes === expectedPayloadBytes &&
    workload.inputFingerprint === expectedFingerprint

  if (!validWorkload) {
    throw new ValidationError(`The workload proof differs from the shared contract: ${JSON.stringify(workload)}`)
  }

  workloadContract ??= workload
  if (JSON.stringify(workload) !== JSON.stringify(workloadContract)) {
    throw new ValidationError('The workload proof changed between requests')
  }

  allTrackIds.add(execution.trackId)
  allThreadIds.add(execution.threadId)
  allProcessIds.add(execution.pid)
  stageTrackIds.add(execution.trackId)
  stageThreadIds.add(execution.threadId)
}

function metricMaximum(snapshot, name) {
  const values = snapshot?.metrics?.[name] ?? []
  return Math.max(0, ...values.filter(Number.isFinite).map(Number))
}

function normalizeTelemetry(snapshot, stageElapsedMs) {
  const userCpuSeconds = metricMaximum(snapshot, 'app.process.cpu.user')
  const systemCpuSeconds = metricMaximum(snapshot, 'app.process.cpu.system')
  const rssBytes = metricMaximum(snapshot, 'app.process.memory.rss')
  const maxRssBytes = metricMaximum(snapshot, 'app.process.memory.max_rss')

  return {
    capturedAt: snapshot?.timestamp ?? new Date().toISOString(),
    stageElapsedMs,
    heapUsedBytes: metricMaximum(snapshot, 'app.process.heap.used'),
    heapTotalBytes: metricMaximum(snapshot, 'app.process.heap.total'),
    externalBytes: metricMaximum(snapshot, 'app.process.memory.external'),
    rssBytes: rssBytes || maxRssBytes,
    maxRssBytes: maxRssBytes || rssBytes,
    eventLoopLagSeconds: metricMaximum(snapshot, 'app.event_loop.lag'),
    userCpuSeconds,
    systemCpuSeconds,
    cpuTotalSeconds: userCpuSeconds + systemCpuSeconds,
    poolQueueSize: metricMaximum(snapshot, 'app.pool.queue.size'),
    jobQueueWaiting: metricMaximum(snapshot, 'app.job_queue.waiting'),
    jobQueueActive: metricMaximum(snapshot, 'app.job_queue.active'),
    poolMaxThreads: metricMaximum(snapshot, 'app.pool.threads.max'),
    poolTasksCompleted: metricMaximum(snapshot, 'app.pool.tasks.completed')
  }
}

function createResourcePeaks() {
  return {
    heapUsedBytes: 0,
    heapTotalBytes: 0,
    externalBytes: 0,
    rssBytes: 0,
    maxRssBytes: 0,
    eventLoopLagSeconds: 0,
    poolQueueSize: 0,
    jobQueueWaiting: 0,
    jobQueueActive: 0,
    poolMaxThreads: 0
  }
}

function updateResourcePeaks(peaks, sample) {
  for (const key of Object.keys(peaks)) {
    peaks[key] = Math.max(peaks[key], sample[key] ?? 0)
  }
}

async function waitForServer() {
  const deadline = Date.now() + 30_000
  let lastError = 'health check did not return HTTP 200'

  while (Date.now() < deadline) {
    try {
      const response = await request('/non-blocking/', {
        method: 'GET',
        timeoutMs: 2_000
      })
      if (response.data) return
    } catch (error) {
      lastError = describeError(error)
    }

    await delay(500)
  }

  throw new Error(`Service at ${baseUrl} is not ready: ${lastError}`)
}

async function runStage(concurrency) {
  const durations = []
  const probeDurations = []
  const stageTrackIds = new Set()
  const stageThreadIds = new Set()
  const errors = []
  const validationErrors = []
  const resourceSamples = []
  const resourcePeaks = createResourcePeaks()
  const loadControllers = new Set()
  const stageStartedAt = performance.now()
  const deadline = stageStartedAt + stageDurationMs
  let requestsStarted = 0
  let successfulRequests = 0
  let failedRequests = 0
  let resourceMonitorFailures = 0
  let consecutiveResourceFailures = 0
  let stageActive = true
  let stopLaunching = false
  let stopReason

  const stopStage = (reason, abortActiveRequests = false) => {
    if (!stopReason) stopReason = reason
    stopLaunching = true

    if (abortActiveRequests) {
      for (const controller of loadControllers) controller.abort()
    }
  }

  const collectTelemetry = async () => {
    const result = await request('/telemetry/resources', {
      method: 'GET',
      timeoutMs: monitorRequestTimeoutMs
    })
    const sample = normalizeTelemetry(result.data, performance.now() - stageStartedAt)
    resourceSamples.push(sample)
    updateResourcePeaks(resourcePeaks, sample)
    consecutiveResourceFailures = 0

    const observedRss = Math.max(sample.rssBytes, sample.maxRssBytes)
    if (observedRss >= rssLimitBytes) {
      stopStage(
        `rss-limit: ${(observedRss / 1024 / 1024).toFixed(2)} MB reached ` +
        `${rssLimitPercent.toFixed(2)}% of the ${memoryLimitMb.toFixed(2)} MB service limit`,
        true
      )
    }
  }

  const resourceMonitor = (async () => {
    while (stageActive) {
      try {
        await collectTelemetry()
      } catch (error) {
        resourceMonitorFailures += 1
        consecutiveResourceFailures += 1
        if (errors.length < 20) {
          errors.push({ type: 'telemetry', message: describeError(error) })
        }
        if (consecutiveResourceFailures >= 3) {
          stopStage('service-unavailable: three consecutive telemetry requests failed', true)
        }
      }

      if (stageActive) await delay(monitorIntervalMs)
    }
  })()

  const probe = (async () => {
    while (stageActive) {
      try {
        const result = await request('/non-blocking/', {
          method: 'GET',
          timeoutMs: monitorRequestTimeoutMs
        })
        probeDurations.push(result.durationMs)
      } catch {
        // Probe failures are represented by the stage resource and request error counters.
      }

      if (stageActive) await delay(100)
    }
  })()

  const minimumErrorSamples = Math.min(25, concurrency)
  const clients = Array.from({ length: concurrency }, async () => {
    while (!stopLaunching && performance.now() < deadline) {
      const requestNumber = requestsStarted
      requestsStarted += 1

      try {
        const result = await executeScenarioRequest(loadControllers)
        validateResponse(result.data, stageTrackIds, stageThreadIds)
        durations.push(result.durationMs)
        successfulRequests += 1
      } catch (error) {
        failedRequests += 1
        const message = describeError(error)

        if (error instanceof ValidationError) {
          validationErrors.push({ requestNumber, message })
          stopStage(`validation-failure: ${message}`, true)
        } else if (errors.length < 20) {
          errors.push({ type: 'request', requestNumber, message })
        }

        const completedRequests = successfulRequests + failedRequests
        const errorRatePercent = completedRequests === 0
          ? 0
          : failedRequests / completedRequests * 100

        if (completedRequests >= minimumErrorSamples &&
            errorRatePercent >= maxErrorRatePercent &&
            failedRequests > 0) {
          stopStage(
            `error-rate: ${errorRatePercent.toFixed(2)}% reached the ` +
            `${maxErrorRatePercent.toFixed(2)}% limit`,
            true
          )
        }
      }
    }
  })

  await Promise.all(clients)
  stageActive = false
  await Promise.all([resourceMonitor, probe])

  const elapsedMs = performance.now() - stageStartedAt
  const completedRequests = successfulRequests + failedRequests
  const firstCpuSample = resourceSamples.find((sample) => sample.cpuTotalSeconds > 0)
  const lastCpuSample = [...resourceSamples]
    .reverse()
    .find((sample) => sample.cpuTotalSeconds > 0)
  const cpuDeltaSeconds = firstCpuSample && lastCpuSample
    ? Math.max(0, lastCpuSample.cpuTotalSeconds - firstCpuSample.cpuTotalSeconds)
    : 0
  const cpuWindowSeconds = firstCpuSample && lastCpuSample
    ? Math.max(0, (lastCpuSample.stageElapsedMs - firstCpuSample.stageElapsedMs) / 1_000)
    : 0
  const cpuUtilizationPercent = cpuWindowSeconds > 0
    ? cpuDeltaSeconds / cpuWindowSeconds / cpuLimit * 100
    : 0

  return {
    concurrency,
    configuredDurationMs: stageDurationMs,
    elapsedMs,
    requestsStarted,
    successfulRequests,
    failedRequests,
    errorRatePercent: completedRequests === 0 ? 0 : failedRequests / completedRequests * 100,
    throughput: elapsedMs > 0 ? successfulRequests / (elapsedMs / 1_000) : 0,
    attemptedThroughput: elapsedMs > 0 ? completedRequests / (elapsedMs / 1_000) : 0,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99),
    probeP95Ms: percentile(probeDurations, 0.95),
    trackIds: stageTrackIds.size,
    threadIds: [...stageThreadIds].sort((left, right) => left - right),
    resourceMonitorFailures,
    resourceSamples,
    resourcePeaks,
    cpuDeltaSeconds,
    cpuUtilizationPercent,
    stopReason,
    errors,
    validationErrors
  }
}

function stageForConsole(stage) {
  return {
    concurrency: stage.concurrency,
    requests: `${stage.successfulRequests}/${stage.requestsStarted}`,
    throughput: `${stage.throughput.toFixed(2)} req/s`,
    p50: `${stage.p50Ms.toFixed(2)} ms`,
    p95: `${stage.p95Ms.toFixed(2)} ms`,
    p99: `${stage.p99Ms.toFixed(2)} ms`,
    probeP95: `${stage.probeP95Ms.toFixed(2)} ms`,
    rss: `${(stage.resourcePeaks.rssBytes / 1024 / 1024).toFixed(2)} MB`,
    cpu: `${stage.cpuUtilizationPercent.toFixed(2)}%`,
    queue: Math.max(
      stage.resourcePeaks.poolQueueSize,
      stage.resourcePeaks.jobQueueWaiting
    ),
    errors: `${stage.errorRatePercent.toFixed(2)}%`
  }
}

async function writeReport(report) {
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, JSON.stringify(report, null, 2))
}

const report = {
  status: 'running',
  generatedAt: new Date().toISOString(),
  mode: scenario.mode,
  endpoint: scenario.endpoint,
  baseUrl,
  configuration: {
    concurrencySteps: steps,
    stageDurationMs,
    requestTimeoutMs,
    payloadBytes,
    memoryLimitMb,
    rssLimitPercent,
    maxErrorRatePercent,
    cpuLimit,
    settleMs,
    monitorIntervalMs
  },
  workload: undefined,
  stages: [],
  summary: undefined,
  error: undefined
}

console.log(`Brute-force saturation test: ${baseUrl}`)
console.log(`Mode=${scenario.mode}, endpoint=${scenario.endpoint}`)
console.log(`Concurrency ramp=${steps.join(', ')}, stage=${stageDurationMs} ms, payload=${payloadBytes} bytes`)
console.log(`Stop threshold=RSS ${rssLimitPercent}% of ${memoryLimitMb} MB or errors ${maxErrorRatePercent}%`)

try {
  await waitForServer()
  await verifyBullMqIdempotency()

  const preflightTrackIds = new Set()
  const preflightThreadIds = new Set()
  const preflight = await executeScenarioRequest()
  validateResponse(preflight.data, preflightTrackIds, preflightThreadIds)
  report.workload = {
    hash: expectedHash,
    proof: workloadContract
  }
  console.log(`Preflight validated: ${expectedFingerprint}`)

  let saturationStage
  let highestHealthyStage
  let cpuSaturationStage

  for (const concurrency of steps) {
    console.log(`\nStarting concurrency stage ${concurrency}`)
    const stage = await runStage(concurrency)
    report.stages.push(stage)
    console.table([stageForConsole(stage)])

    if (!cpuSaturationStage && stage.cpuUtilizationPercent >= 90) {
      cpuSaturationStage = concurrency
    }

    if (stage.validationErrors.length > 0) {
      report.status = 'failed'
      saturationStage = stage
      break
    }

    if (stage.stopReason) {
      report.status = 'saturated'
      saturationStage = stage
      break
    }

    highestHealthyStage = stage
    if (settleMs > 0 && concurrency !== steps.at(-1)) await delay(settleMs)
  }

  if (report.status === 'running') report.status = 'completed'

  if (scenario.mode !== 'single-thread' && allThreadIds.size < 2) {
    report.status = 'failed'
    report.error = `Only ${allThreadIds.size} worker thread was observed`
  }

  const allPeaks = createResourcePeaks()
  for (const stage of report.stages) updateResourcePeaks(allPeaks, stage.resourcePeaks)

  report.summary = {
    terminationReason: saturationStage?.stopReason ?? 'configured concurrency ceiling reached',
    saturationConcurrency: saturationStage?.concurrency,
    highestHealthyConcurrency: highestHealthyStage?.concurrency,
    cpuSaturationConcurrency: cpuSaturationStage,
    observedThreadIds: [...allThreadIds].sort((left, right) => left - right),
    observedProcessIds: [...allProcessIds],
    uniqueTrackIds: allTrackIds.size,
    resourcePeaks: allPeaks
  }
} catch (error) {
  report.status = 'failed'
  report.error = describeError(error)
}

await writeReport(report)

console.log('\nBrute-force result')
console.log(`  status: ${report.status}`)
console.log(`  termination: ${report.summary?.terminationReason ?? report.error}`)
console.log(`  highest healthy concurrency: ${report.summary?.highestHealthyConcurrency ?? 'none'}`)
console.log(`  CPU saturation concurrency: ${report.summary?.cpuSaturationConcurrency ?? 'not observed'}`)
console.log(`  worker thread IDs: ${report.summary?.observedThreadIds.join(', ') || 'none'}`)
console.log(`  JSON report: ${outputPath}`)

if (report.status === 'failed') process.exitCode = 1
