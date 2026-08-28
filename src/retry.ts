import { runWorker } from './worker.js'
import { DEFAULT_MAX_RETRIES, RETRY_BACKOFF_BASE_MS } from './const.js'
import type { HashResult, WorkerData } from './types.js'

export async function runWithRetry(
  workerData: WorkerData,
  maxRetries = DEFAULT_MAX_RETRIES
): Promise<HashResult> {
  if (maxRetries < 1) {
    throw new Error('maxRetries must be at least 1')
  }

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await runWorker(workerData)
    } catch (error) {
      if (attempt === maxRetries - 1) throw error
      await new Promise<void>((resolve) =>
        setTimeout(resolve, 2 ** attempt * RETRY_BACKOFF_BASE_MS)
      )
    }
  }

  throw new Error('Worker retries exhausted')
}
