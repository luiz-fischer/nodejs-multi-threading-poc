import { Worker } from 'node:worker_threads'
import type { HashResult, WorkerData, WorkerMessage } from './types.js'
import { createUuidV7, getRequestContext } from './track-context.js'
import {
  hashJobsCompleted,
  hashJobsFailed,
  hashJobsStarted,
  startHashJobTimer
} from './metrics.js'

import {
  MAX_TASKS_PER_WORKER,
  WORKER_PATH,
  WORKER_RESOURCE_LIMITS,
  WORKER_TIMEOUT_MS
} from './const.js'

export function runWorker(workerData: WorkerData): Promise<HashResult> {
  const trackedWorkerData = {
    ...workerData,
    trackId: workerData.trackId ?? getRequestContext()?.trackId ?? createUuidV7()
  }
  hashJobsStarted.add(1)
  const stopTimer = startHashJobTimer()

  return new Promise<HashResult>((resolve, reject) => {
    let settled = false

    const worker = new Worker(WORKER_PATH, {
      workerData: trackedWorkerData,
      resourceLimits: WORKER_RESOURCE_LIMITS
    })

    const timeout = setTimeout(() => {
      if (settled) return
      safeReject(new Error('Worker timeout'))
    }, WORKER_TIMEOUT_MS)

    function safeResolve(value: HashResult) {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      worker.terminate()
      hashJobsCompleted.add(1)
      stopTimer()
      resolve(value)
    }

    function safeReject(error: Error) {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      worker.terminate()
      hashJobsFailed.add(1)
      stopTimer()
      reject(error)
    }

    worker.once('message', (message: WorkerMessage) => {
      if (message.status === 'ok') {
        safeResolve(message.result)
      } else {
        safeReject(new Error(message.message))
      }
    })

    worker.once('error', (error: Error) => {
      safeReject(error)
    })

    worker.once('exit', (code: number) => {
      if (code !== 0) {
        safeReject(new Error(`Worker exited with code ${code}`))
      }
    })
  })
}

export function runWorkerWithTimeout(workerData: WorkerData, timeoutMs = WORKER_TIMEOUT_MS): Promise<WorkerMessage> {
  return new Promise<WorkerMessage>((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, { workerData })
    const timeout = setTimeout(() => {
      worker.terminate()
      reject(new Error('Worker timeout'))
    }, timeoutMs)

    worker.once('message', (message: WorkerMessage) => {
      clearTimeout(timeout)
      resolve(message)
      worker.terminate()
    })

    worker.once('error', (error: Error) => {
      clearTimeout(timeout)
      worker.terminate()
      reject(error)
    })
  })
}


const workerTaskCounts = new WeakMap<Worker, number>()

export function createRecyclableWorker(workerPath: string, workerData: WorkerData): Worker {
  const worker = new Worker(workerPath, { workerData })
  workerTaskCounts.set(worker, 0)
  return worker
}

export function recordWorkerTask(worker: Worker): void {
  const current = workerTaskCounts.get(worker) ?? 0
  const next = current + 1
  workerTaskCounts.set(worker, next)

  if (next >= MAX_TASKS_PER_WORKER) {
    worker.terminate()
    workerTaskCounts.delete(worker)
  }
}
