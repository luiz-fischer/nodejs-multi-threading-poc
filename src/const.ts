import * as operatingSystem from 'node:os'
import { fileURLToPath } from 'node:url'
import type { ResourceLimits } from 'node:worker_threads'
import 'dotenv/config'
import type { EnvTypes } from './types.js'

const availableParallelism = 'availableParallelism' in operatingSystem &&
  typeof operatingSystem.availableParallelism === 'function'
  ? operatingSystem.availableParallelism
  : () => operatingSystem.cpus().length

export const APP_NAME = 'nodejs-multi-threading-poc'
export const APP_VERSION = '1.0.0'
export const DEFAULT_PORT = 3000
export const ALL_ENVS: EnvTypes = {
  PORT: process.env.PORT ?? String(DEFAULT_PORT),
  REDIS_HOST: process.env.REDIS_HOST ?? '127.0.0.1',
  REDIS_PORT: process.env.REDIS_PORT ?? '6379'
}
export const MAX_HASH_PAYLOAD_LENGTH = 1_000_000
export const HASH_ALGORITHM = 'sha256'
export const HASH_ENCODING = 'utf8'
export const HASH_ROUNDS = Math.max(
  1,
  Number(process.env.HASH_ROUNDS ?? 10)
)
export const WORKER_TIMEOUT_MS = 10_000
export const MAX_TASKS_PER_WORKER = 1_000
export const DEFAULT_MAX_RETRIES = 3
export const RETRY_BACKOFF_BASE_MS = 1_000

export const WORKER_PATH = fileURLToPath(new URL('./workers.js', import.meta.url))
export const PISCINA_WORKER_PATH = fileURLToPath(new URL('./piscina-worker.js', import.meta.url))

export const WORKER_RESOURCE_LIMITS: ResourceLimits = {
  maxOldGenerationSizeMb: 28,
  maxYoungGenerationSizeMb: 6,
  stackSizeMb: 2
}

export const PISCINA_MAX_THREADS = Math.max(
  1,
  Number(process.env.PISCINA_MAX_THREADS ?? availableParallelism())
)
export const PISCINA_MIN_THREADS = Math.min(2, PISCINA_MAX_THREADS)
export const PISCINA_IDLE_TIMEOUT_MS = 30_000
export const PISCINA_MAX_QUEUE = Math.max(
  1,
  Number(process.env.PISCINA_MAX_QUEUE ?? 64)
)
export const DEFAULT_WORKER_MAX_CONCURRENCY = Math.max(
  1,
  Math.min(3, availableParallelism())
)
export const WORKER_MAX_CONCURRENCY = Math.max(
  1,
  Number(process.env.WORKER_MAX_CONCURRENCY ?? DEFAULT_WORKER_MAX_CONCURRENCY)
)
export const WORKER_MAX_QUEUE = Math.max(
  1,
  Number(process.env.WORKER_MAX_QUEUE ?? 64)
)
export const WORKER_EXEC_ARGV = process.execArgv.filter(
  (argument) => !argument.startsWith('--import')
)
export const PISCINA_RESOURCE_LIMITS: ResourceLimits = {
  maxOldGenerationSizeMb: 80
}

export const JOB_QUEUE_CONCURRENCY = 8
export const JOB_QUEUE_INTERVAL_CAP = 100
export const JOB_QUEUE_INTERVAL_MS = 1_000

export const BULLMQ_QUEUE_NAME = 'native-hash-jobs'
export const BULLMQ_JOB_NAME = 'hash'
export const BULLMQ_JOB_ATTEMPTS = 3
export const BULLMQ_JOB_BACKOFF_MS = 1_000
export const BULLMQ_JOB_LOCK_DURATION_MS = 60_000
export const BULLMQ_COMPLETED_RETENTION_SECONDS = 3_600
export const BULLMQ_COMPLETED_RETENTION_COUNT = 5_000
export const BULLMQ_FAILED_RETENTION_SECONDS = 86_400
export const BULLMQ_FAILED_RETENTION_COUNT = 1_000
export const BULLMQ_PAYLOAD_DIRECTORY = process.env.BULLMQ_PAYLOAD_DIRECTORY ??
  '/tmp/nodejs-multithreading-payloads'
export const BULLMQ_JOB_STATUS_PATH = '/api/raw-worker/hash'
export const BULLMQ_STATUS_POLL_INTERVAL_MS = 100

export const OTEL_METER_NAME = APP_NAME
export const OTEL_METER_VERSION = APP_VERSION
export const OTEL_METRIC_EXPORT_INTERVAL_MS = 1_000
export const OTEL_CONSOLE_EXPORTER_ENABLED = process.env.OTEL_CONSOLE_EXPORTER !== 'false'

export const DEV_RESTART_DEBOUNCE_MS = 150

export const LOG_FILE = process.env.LOG_FILE ?? ''
export const LOG_REQUESTS = process.env.LOG_REQUESTS === 'true'

export const STRESS_DEFAULT_REQUESTS = 1_000
export const STRESS_DEFAULT_CONCURRENCY = 32
export const STRESS_DEFAULT_PAYLOAD_BYTES = 900_000
export const STRESS_DEFAULT_TIMEOUT_MS = 120_000

export const BRUTE_FORCE_DEFAULT_CONCURRENCY_STEPS = Object.freeze([
  16,
  32,
  64,
  96,
  128,
  192,
  256,
  384,
  512,
  768,
  1_024
])
export const BRUTE_FORCE_DEFAULT_STAGE_DURATION_MS = 10_000
export const BRUTE_FORCE_DEFAULT_REQUEST_TIMEOUT_MS = 30_000
export const BRUTE_FORCE_DEFAULT_MEMORY_LIMIT_MB = 512
export const BRUTE_FORCE_DEFAULT_RSS_LIMIT_PERCENT = 90
export const BRUTE_FORCE_DEFAULT_MAX_ERROR_RATE_PERCENT = 1
export const BRUTE_FORCE_DEFAULT_CPU_LIMIT = 4
export const BRUTE_FORCE_DEFAULT_SETTLE_MS = 1_000
export const BRUTE_FORCE_DEFAULT_MONITOR_INTERVAL_MS = 250
