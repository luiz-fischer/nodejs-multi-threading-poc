import { createHash } from 'node:crypto'
import { isMainThread, threadId } from 'node:worker_threads'
import process from 'node:process'
import { HASH_ALGORITHM, HASH_ENCODING } from './const.js'
import type { PoolWorkerData, WorkerMessage } from './types.js'

export default function hashWorker({ payload, trackId }: PoolWorkerData): WorkerMessage {
  try {
    const hash = createHash(HASH_ALGORITHM).update(payload, HASH_ENCODING).digest('hex')
    return {
      status: 'ok',
      result: {
        hash,
        execution: {
          mode: 'piscina',
          isMainThread,
          threadId,
          pid: process.pid,
          trackId
        }
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to hash payload'
    return { status: 'error', message }
  }
}
