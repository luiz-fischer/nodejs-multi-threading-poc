import { isMainThread, threadId } from 'node:worker_threads'
import process from 'node:process'
import { HASH_ROUNDS } from './const.js'
import { hashPayload } from './hash.js'
import type { PoolWorkerData, WorkerMessage } from './types.js'

export default function hashWorker({ payload, trackId }: PoolWorkerData): WorkerMessage {
  try {
    const hash = hashPayload(payload)
    return {
      status: 'ok',
      result: {
        hash,
        execution: {
          mode: 'piscina',
          isMainThread,
          threadId,
          pid: process.pid,
          trackId,
          hashRounds: HASH_ROUNDS
        }
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to hash payload'
    return { status: 'error', message }
  }
}
