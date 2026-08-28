import { isMainThread, parentPort, threadId, workerData } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import process from 'node:process'
import { HASH_ALGORITHM, HASH_ENCODING } from './const.js'
import type { WorkerData } from './types.js'

if (!parentPort) {
    throw new Error('Worker parent port is not available')
}

try {
    const { payload, trackId } = workerData as WorkerData
  const hash = hashBuffer(payload)
  parentPort.postMessage({
    status: 'ok',
    result: {
      hash,
      execution: {
        mode: 'worker-thread',
        isMainThread,
        threadId,
        pid: process.pid,
        trackId: trackId ?? 'unknown'
      }
    }
  })
} catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to hash payload'
    parentPort.postMessage({ status: 'error', message })
}

function hashBuffer(payload: string): string {
    const hash = createHash(HASH_ALGORITHM)
    hash.update(payload, HASH_ENCODING)
    return hash.digest('hex')
}
