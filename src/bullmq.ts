import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Queue, Worker as BullMqWorker, type Job } from 'bullmq'
import { Redis } from 'ioredis'
import {
  ALL_ENVS,
  BULLMQ_COMPLETED_RETENTION_COUNT,
  BULLMQ_COMPLETED_RETENTION_SECONDS,
  BULLMQ_FAILED_RETENTION_COUNT,
  BULLMQ_FAILED_RETENTION_SECONDS,
  BULLMQ_JOB_ATTEMPTS,
  BULLMQ_JOB_BACKOFF_MS,
  BULLMQ_JOB_LOCK_DURATION_MS,
  BULLMQ_JOB_NAME,
  BULLMQ_JOB_STATUS_PATH,
  BULLMQ_PAYLOAD_DIRECTORY,
  BULLMQ_QUEUE_NAME,
  WORKER_MAX_CONCURRENCY
} from './const.js'
import { writeLog } from './logger.js'
import { registerJobQueueMetrics } from './metrics.js'
import { runWorker } from './worker.js'
import type {
  BullMqHashJobData,
  HashJobSnapshot,
  HashJobSubmission,
  HashResult,
  HashTask,
  JobQueueCounts
} from './types.js'

let hashQueue: Queue<BullMqHashJobData, HashResult, typeof BULLMQ_JOB_NAME> | undefined
let hashQueueWorker: BullMqWorker<BullMqHashJobData, HashResult, typeof BULLMQ_JOB_NAME> | undefined
let producerRedis: Redis | undefined
let workerRedis: Redis | undefined
let queueMetricsRegistered = false
const pendingSubmissions = new Map<string, Promise<HashJobSubmission>>()

function getProducerRedis(): Redis {
  producerRedis ??= new Redis({
    host: ALL_ENVS.REDIS_HOST,
    port: Number(ALL_ENVS.REDIS_PORT),
    maxRetriesPerRequest: 1
  })
  return producerRedis
}

function getWorkerRedis(): Redis {
  workerRedis ??= new Redis({
    host: ALL_ENVS.REDIS_HOST,
    port: Number(ALL_ENVS.REDIS_PORT),
    maxRetriesPerRequest: null
  })
  return workerRedis
}

function getHashQueue(): Queue<BullMqHashJobData, HashResult, typeof BULLMQ_JOB_NAME> {
  if (!hashQueue) {
    hashQueue = new Queue<BullMqHashJobData, HashResult, typeof BULLMQ_JOB_NAME>(
      BULLMQ_QUEUE_NAME,
      {
        connection: getProducerRedis(),
        defaultJobOptions: {
          attempts: BULLMQ_JOB_ATTEMPTS,
          backoff: {
            type: 'exponential',
            delay: BULLMQ_JOB_BACKOFF_MS
          },
          removeOnComplete: {
            age: BULLMQ_COMPLETED_RETENTION_SECONDS,
            count: BULLMQ_COMPLETED_RETENTION_COUNT
          },
          removeOnFail: {
            age: BULLMQ_FAILED_RETENTION_SECONDS,
            count: BULLMQ_FAILED_RETENTION_COUNT
          }
        }
      }
    )

    hashQueue.on('error', (error) => {
      writeLog('error', 'bullmq.queue_error', { error: error.message })
    })

    if (!queueMetricsRegistered) {
      registerJobQueueMetrics(readHashQueueCounts)
      queueMetricsRegistered = true
    }
  }

  return hashQueue
}

function getHashQueueWorker(): BullMqWorker<
  BullMqHashJobData,
  HashResult,
  typeof BULLMQ_JOB_NAME
> {
  if (!hashQueueWorker) {
    hashQueueWorker = new BullMqWorker<
      BullMqHashJobData,
      HashResult,
      typeof BULLMQ_JOB_NAME
    >(
      BULLMQ_QUEUE_NAME,
      processHashJob,
      {
        connection: getWorkerRedis(),
        concurrency: WORKER_MAX_CONCURRENCY,
        lockDuration: BULLMQ_JOB_LOCK_DURATION_MS,
        maxStalledCount: 1
      }
    )

    hashQueueWorker.on('error', (error) => {
      writeLog('error', 'bullmq.worker_error', { error: error.message })
    })
    hashQueueWorker.on('failed', (job, error) => {
      writeLog('error', 'bullmq.job_failed', {
        jobId: job?.id,
        attemptsMade: job?.attemptsMade,
        error: error.message
      })

      if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
        void removePayload(job.data.payloadPath)
      }
    })
  }

  return hashQueueWorker
}

async function processHashJob(
  job: Job<BullMqHashJobData, HashResult, typeof BULLMQ_JOB_NAME>
): Promise<HashResult> {
  const payload = await readFile(job.data.payloadPath, 'utf8')
  const task: HashTask = {
    trackId: job.data.trackId,
    workload: {
      ...job.data.workload,
      payload
    }
  }
  const result = await runWorker(task)
  await removePayload(job.data.payloadPath)
  return result
}

async function removePayload(payloadPath: string): Promise<void> {
  try {
    await unlink(payloadPath)
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException
    if (nodeError.code !== 'ENOENT') {
      writeLog('error', 'bullmq.payload_cleanup_failed', {
        payloadPath,
        error: nodeError.message
      })
    }
  }
}

function createJobId(trackId: string): string {
  return `hash-${trackId}`
}

function createStatusUrl(jobId: string): string {
  return `${BULLMQ_JOB_STATUS_PATH}/${encodeURIComponent(jobId)}`
}

async function createSubmission(
  job: Job<BullMqHashJobData, HashResult, typeof BULLMQ_JOB_NAME>,
  deduplicated: boolean
): Promise<HashJobSubmission> {
  return {
    jobId: job.id ?? createJobId(job.data.trackId),
    trackId: job.data.trackId,
    status: await job.getState(),
    statusUrl: createStatusUrl(job.id ?? createJobId(job.data.trackId)),
    deduplicated
  }
}

async function enqueueNewHashTask(task: HashTask, jobId: string): Promise<HashJobSubmission> {
  const queue = getHashQueue()
  getHashQueueWorker()

  const existingJob = await queue.getJob(jobId)
  if (existingJob) return createSubmission(existingJob, true)

  await mkdir(BULLMQ_PAYLOAD_DIRECTORY, { recursive: true })
  const payloadPath = join(BULLMQ_PAYLOAD_DIRECTORY, `${jobId}.payload`)

  await writeFile(payloadPath, task.workload.payload, {
    encoding: task.workload.encoding,
    flag: 'wx'
  })

  try {
    const job = await queue.add(
      BULLMQ_JOB_NAME,
      {
        trackId: task.trackId,
        payloadPath,
        workload: {
          algorithm: task.workload.algorithm,
          encoding: task.workload.encoding,
          rounds: task.workload.rounds
        }
      },
      {
        jobId,
        deduplication: {
          id: task.trackId
        }
      }
    )

    return createSubmission(job, false)
  } catch (error) {
    await removePayload(payloadPath)
    throw error
  }
}

export function enqueueHashTask(task: HashTask): Promise<HashJobSubmission> {
  const jobId = createJobId(task.trackId)
  const existingSubmission = pendingSubmissions.get(jobId)

  if (existingSubmission) {
    return existingSubmission.then((submission) => ({
      ...submission,
      deduplicated: true
    }))
  }

  const submission = enqueueNewHashTask(task, jobId)
    .finally(() => {
      pendingSubmissions.delete(jobId)
    })
  pendingSubmissions.set(jobId, submission)
  return submission
}

export async function getHashJob(jobId: string): Promise<HashJobSnapshot | undefined> {
  const queue = getHashQueue()
  getHashQueueWorker()
  const job = await queue.getJob(jobId)
  if (!job) return undefined

  const status = await job.getState()
  return {
    jobId,
    trackId: job.data.trackId,
    status,
    result: status === 'completed' ? job.returnvalue : undefined,
    error: status === 'failed' ? job.failedReason : undefined
  }
}

export function isHashJobId(value: unknown): value is string {
  return typeof value === 'string' &&
    /^hash-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

async function readHashQueueCounts(): Promise<JobQueueCounts> {
  if (!hashQueue) {
    return {
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0
    }
  }

  const counts = await hashQueue.getJobCounts(
    'waiting',
    'active',
    'completed',
    'failed',
    'delayed'
  )

  return {
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
    delayed: counts.delayed ?? 0
  }
}

export async function shutdownHashQueue(): Promise<void> {
  pendingSubmissions.clear()

  if (hashQueueWorker) {
    await hashQueueWorker.close()
    hashQueueWorker = undefined
  }

  if (hashQueue) {
    await hashQueue.close()
    hashQueue = undefined
  }

  if (workerRedis) {
    await workerRedis.quit()
    workerRedis = undefined
  }

  if (producerRedis) {
    await producerRedis.quit()
    producerRedis = undefined
  }
}
