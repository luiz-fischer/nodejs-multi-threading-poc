import { Worker } from 'node:worker_threads'
import {
  WORKER_EXEC_ARGV,
  WORKER_MAX_CONCURRENCY,
  WORKER_MAX_QUEUE,
  WORKER_PATH,
  WORKER_RESOURCE_LIMITS
} from './const.js'
import type {
  HashResult,
  HashTask,
  PendingWorkerPoolTask,
  PoolMetricsSource,
  WorkerPoolMessage,
  WorkerPoolSlot,
  WorkerPoolTask
} from './types.js'

export class WorkerPool implements PoolMetricsSource {
  private readonly queue: PendingWorkerPoolTask[] = []
  private readonly slots: WorkerPoolSlot[]
  private nextTaskId = 0
  private completedTasks = 0
  private closed = false
  readonly options: PoolMetricsSource['options']

  constructor(private readonly size = WORKER_MAX_CONCURRENCY) {
    this.options = Object.freeze({ maxThreads: size })
    this.slots = Array.from({ length: size }, () => this.createSlot())
  }

  get queueSize(): number {
    return this.queue.length
  }

  get completed(): number {
    return this.completedTasks
  }

  run(hashTask: HashTask): Promise<HashResult> {
    if (this.closed) {
      return Promise.reject(new Error('Worker pool is closed'))
    }

    if (this.queue.length >= WORKER_MAX_QUEUE) {
      return Promise.reject(new Error('Worker pool queue is full'))
    }

    return new Promise<HashResult>((resolve, reject) => {
      this.queue.push({
        task: {
          taskId: this.nextTaskId++,
          hashTask
        },
        resolve,
        reject
      })
      this.dispatch()
    })
  }

  async close(): Promise<void> {
    this.closed = true
    const closeError = new Error('Worker pool closed')
    for (const pendingTask of this.queue.splice(0)) {
      pendingTask.reject(closeError)
    }
    await Promise.all(this.slots.map(({ worker }) => worker.terminate()))
  }

  private createSlot(): WorkerPoolSlot {
    const slot: WorkerPoolSlot = {
      worker: new Worker(WORKER_PATH, {
        execArgv: WORKER_EXEC_ARGV,
        resourceLimits: WORKER_RESOURCE_LIMITS
      })
    }

    slot.worker.on('message', (message: WorkerPoolMessage) => {
      this.completeTask(slot, message)
    })
    slot.worker.on('error', (error: Error) => {
      this.failTask(slot, error)
    })
    slot.worker.on('exit', (code: number) => {
      if (code !== 0) {
        this.failTask(slot, new Error(`Worker exited with code ${code}`))
      }
    })

    return slot
  }

  private completeTask(slot: WorkerPoolSlot, message: WorkerPoolMessage): void {
    const pendingTask = slot.task
    if (!pendingTask || pendingTask.taskId !== message.taskId) return

    slot.task = undefined
    this.completedTasks += 1
    if (message.status === 'ok') {
      pendingTask.resolve(message.result)
    } else {
      pendingTask.reject(new Error(message.message))
    }
    this.dispatch()
  }

  private failTask(slot: WorkerPoolSlot, error: Error): void {
    const pendingTask = slot.task
    slot.task = undefined
    if (pendingTask) this.completedTasks += 1
    pendingTask?.reject(error)
    if (!this.closed) this.dispatch()
  }

  private dispatch(): void {
    for (const slot of this.slots) {
      if (slot.task) continue
      const pendingTask = this.queue.shift()
      if (!pendingTask) return

      slot.task = {
        taskId: pendingTask.task.taskId,
        resolve: pendingTask.resolve,
        reject: pendingTask.reject
      }
      slot.worker.postMessage(pendingTask.task)
    }
  }
}
