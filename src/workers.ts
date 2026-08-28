import process from 'node:process'
import { isMainThread, parentPort, threadId } from 'node:worker_threads'
import { hashPayload } from './hash.js'
import { HASH_ROUNDS } from './const.js'
import type { WorkerPoolTask } from './types.js'

const workerPort = parentPort

if (!workerPort) {
  throw new Error('Worker parent port is not available')
}

workerPort.on('message', (task: WorkerPoolTask) => {
  try {
    const hash = hashPayload(task.payload)
    workerPort.postMessage({
      taskId: task.taskId,
      status: 'ok',
      result: {
        hash,
        execution: {
          mode: 'worker-thread',
          isMainThread,
          threadId,
          pid: process.pid,
          trackId: task.trackId,
          hashRounds: HASH_ROUNDS
        }
      }
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to hash payload'
    workerPort.postMessage({
      taskId: task.taskId,
      status: 'error',
      message
    })
  }
})
