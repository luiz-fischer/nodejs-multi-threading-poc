import process from 'node:process'
import { isMainThread, parentPort, threadId } from 'node:worker_threads'
import { executeHashTask } from './hash.js'
import type { WorkerPoolTask } from './types.js'

const workerPort = parentPort

if (!workerPort) {
  throw new Error('Worker parent port is not available')
}

workerPort.on('message', (task: WorkerPoolTask) => {
  try {
    workerPort.postMessage({
      taskId: task.taskId,
      status: 'ok',
      result: executeHashTask(task.hashTask, {
        mode: 'worker-thread',
        isMainThread,
        threadId,
        pid: process.pid
      })
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
