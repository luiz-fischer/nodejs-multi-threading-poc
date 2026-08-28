import { Piscina } from 'piscina'
import {
  PISCINA_IDLE_TIMEOUT_MS,
  PISCINA_MAX_THREADS,
  PISCINA_MIN_THREADS,
  PISCINA_RESOURCE_LIMITS,
  PISCINA_WORKER_PATH
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

const piscina = new Piscina<PoolWorkerData, WorkerMessage>({
  filename: PISCINA_WORKER_PATH,
  minThreads: PISCINA_MIN_THREADS,
  maxThreads: PISCINA_MAX_THREADS,
  idleTimeout: PISCINA_IDLE_TIMEOUT_MS,
  resourceLimits: PISCINA_RESOURCE_LIMITS
})

registerPoolMetrics(piscina)

export async function hashWithPool(
  payload: string,
  trackId = getRequestContext()?.trackId ?? createUuidV7()
): Promise<HashResult> {
  hashJobsStarted.add(1)
  const stopTimer = startHashJobTimer()

  try {
    const message = await piscina.run({ payload, trackId })

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

export { piscina }
