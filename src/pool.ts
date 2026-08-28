import { Piscina } from 'piscina'
import {
  PISCINA_IDLE_TIMEOUT_MS,
  PISCINA_MAX_QUEUE,
  PISCINA_MAX_THREADS,
  PISCINA_MIN_THREADS,
  PISCINA_RESOURCE_LIMITS,
  PISCINA_WORKER_PATH,
  WORKER_EXEC_ARGV
} from './const.js'
import {
  hashJobsCompleted,
  hashJobsFailed,
  hashJobsStarted,
  registerPoolMetrics,
  startHashJobTimer
} from './metrics.js'
import { createUuidV7, getRequestContext } from './track-context.js'
import type { HashResult, PoolWorkerData, WorkerMessage } from './types.js'

let piscina: Piscina<PoolWorkerData, WorkerMessage> | undefined

function getPool(): Piscina<PoolWorkerData, WorkerMessage> {
  if (!piscina) {
    piscina = new Piscina<PoolWorkerData, WorkerMessage>({
      filename: PISCINA_WORKER_PATH,
      minThreads: PISCINA_MIN_THREADS,
      maxThreads: PISCINA_MAX_THREADS,
      maxQueue: PISCINA_MAX_QUEUE,
      idleTimeout: PISCINA_IDLE_TIMEOUT_MS,
      execArgv: WORKER_EXEC_ARGV,
      resourceLimits: PISCINA_RESOURCE_LIMITS
    })
    registerPoolMetrics(piscina)
  }

  return piscina
}

export async function hashWithPool(
  payload: string,
  trackId = getRequestContext()?.trackId ?? createUuidV7()
): Promise<HashResult> {
  const pool = getPool()
  hashJobsStarted.add(1)
  const stopTimer = startHashJobTimer()

  try {
    const message = await pool.run({ payload, trackId })

    if (message.status === 'ok') {
      hashJobsCompleted.add(1)
      stopTimer()
      return message.result
    }

    throw new Error(message.message || 'Worker failed')
  } catch (error) {
    hashJobsFailed.add(1)
    stopTimer()
    throw error
  }
}

export async function shutdownPool(): Promise<void> {
  if (!piscina) return
  await piscina.destroy()
  piscina = undefined
}
