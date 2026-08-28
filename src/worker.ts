import {
  hashJobsCompleted,
  hashJobsFailed,
  hashJobsStarted,
  startHashJobTimer
} from './metrics.js'
import { createUuidV7, getRequestContext } from './track-context.js'
import { WorkerPool } from './worker-pool.js'
import type { HashResult, WorkerData } from './types.js'

let workerPool: WorkerPool | undefined

function getWorkerPool(): WorkerPool {
  if (!workerPool) {
    workerPool = new WorkerPool()
  }

  return workerPool
}

export function runWorker(workerData: WorkerData): Promise<HashResult> {
  const trackId = workerData.trackId ?? getRequestContext()?.trackId ?? createUuidV7()
  const pool = getWorkerPool()
  hashJobsStarted.add(1)
  const stopTimer = startHashJobTimer()

  return pool.run(workerData.payload, trackId)
    .then((result) => {
      hashJobsCompleted.add(1)
      stopTimer()
      return result
    })
    .catch((error: unknown) => {
      hashJobsFailed.add(1)
      stopTimer()
      throw error
    })
}

export async function shutdownWorkerPool(): Promise<void> {
  if (!workerPool) return
  await workerPool.close()
  workerPool = undefined
}
