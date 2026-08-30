import { isMainThread, threadId } from 'node:worker_threads'
import process from 'node:process'
import { executeHashTask } from './hash-workload.js'
import type { PoolWorkerData, WorkerMessage } from './types.js'

export default function hashWorker(task: PoolWorkerData): WorkerMessage {
  try {
    return {
      status: 'ok',
      result: executeHashTask(task, {
        mode: 'piscina',
        isMainThread,
        threadId,
        pid: process.pid
      })
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to hash payload'
    return { status: 'error', message }
  }
}
