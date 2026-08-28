import {
  hashJobsCompleted,
  hashJobsFailed,
  hashJobsStarted,
  startHashJobTimer
} from './metrics.js'
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
  const pool = getWorkerPool()
  hashJobsStarted.add(1)
  const stopTimer = startHashJobTimer()

  return pool.run(workerData)
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
