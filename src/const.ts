import { cpus } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { ResourceLimits } from 'node:worker_threads'
import 'dotenv/config'
import type { EnvTypes } from './types.js'

export const APP_NAME = 'nodejs-multi-threading-poc'
export const APP_VERSION = '1.0.0'
export const DEFAULT_PORT = 3000
export const ALL_ENVS: EnvTypes = {
  PORT: process.env.PORT ?? String(DEFAULT_PORT)
}
export const MAX_HASH_PAYLOAD_LENGTH = 1_000_000
export const HASH_ALGORITHM = 'sha256'
export const HASH_ENCODING = 'utf8'
export const WORKER_TIMEOUT_MS = 10_000
export const MAX_TASKS_PER_WORKER = 1_000
export const DEFAULT_MAX_RETRIES = 3
export const RETRY_BACKOFF_BASE_MS = 1_000

export const WORKER_PATH = fileURLToPath(new URL('./workers.js', import.meta.url))
export const PISCINA_WORKER_PATH = fileURLToPath(new URL('./piscina-worker.js', import.meta.url))

export const WORKER_RESOURCE_LIMITS: ResourceLimits = {
  maxOldGenerationSizeMb: 64,
  maxYoungGenerationSizeMb: 16,
  stackSizeMb: 4
}

export const PISCINA_MIN_THREADS = 2
export const PISCINA_MAX_THREADS = Math.max(4, cpus().length)
export const PISCINA_IDLE_TIMEOUT_MS = 30_000
export const PISCINA_RESOURCE_LIMITS: ResourceLimits = {
  maxOldGenerationSizeMb: 80
}

export const JOB_QUEUE_CONCURRENCY = 8
export const JOB_QUEUE_INTERVAL_CAP = 100
export const JOB_QUEUE_INTERVAL_MS = 1_000

export const OTEL_METER_NAME = APP_NAME
export const OTEL_METER_VERSION = APP_VERSION
export const OTEL_METRIC_EXPORT_INTERVAL_MS = 1_000

export const DEV_RESTART_DEBOUNCE_MS = 150

export const STRESS_DEFAULT_REQUESTS = 120
export const STRESS_DEFAULT_CONCURRENCY = 16
export const STRESS_DEFAULT_PAYLOAD_BYTES = 900_000
export const STRESS_DEFAULT_TIMEOUT_MS = 30_000
