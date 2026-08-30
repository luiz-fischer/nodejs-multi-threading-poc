import { monitorEventLoopDelay } from 'node:perf_hooks'
import process from 'node:process'
import { metrics } from '@opentelemetry/api'
import { OTEL_METER_NAME, OTEL_METER_VERSION } from './const.js'
import type { JobQueueMetricsReader, PoolMetricsSource } from './types.js'

const meter = metrics.getMeter(OTEL_METER_NAME, OTEL_METER_VERSION)

const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 })
eventLoopDelay.enable()

meter.createObservableGauge('app.event_loop.lag', {
  description: 'Mean event loop lag in seconds',
  unit: 's'
}).addCallback((result) => {
  result.observe(eventLoopDelay.mean / 1e9)
})

meter.createObservableGauge('app.process.heap.used', {
  description: 'Bytes currently used by the V8 heap',
  unit: 'By'
}).addCallback((result) => {
  result.observe(process.memoryUsage().heapUsed)
})

meter.createObservableGauge('app.process.heap.total', {
  description: 'Total V8 heap size in bytes',
  unit: 'By'
}).addCallback((result) => {
  result.observe(process.memoryUsage().heapTotal)
})

meter.createObservableGauge('app.process.memory.external', {
  description: 'Memory used by native objects in bytes',
  unit: 'By'
}).addCallback((result) => {
  result.observe(process.memoryUsage().external)
})

meter.createObservableGauge('app.process.memory.rss', {
  description: 'Current resident set size in bytes',
  unit: 'By'
}).addCallback((result) => {
  result.observe(process.memoryUsage().rss)
})

meter.createObservableGauge('app.process.memory.max_rss', {
  description: 'Maximum resident set size in bytes',
  unit: 'By'
}).addCallback((result) => {
  result.observe(process.resourceUsage().maxRSS * 1024)
})

meter.createObservableGauge('app.process.cpu.user', {
  description: 'User CPU time consumed by the process',
  unit: 's'
}).addCallback((result) => {
  result.observe(process.resourceUsage().userCPUTime / 1e6)
})

meter.createObservableGauge('app.process.cpu.system', {
  description: 'System CPU time consumed by the process',
  unit: 's'
}).addCallback((result) => {
  result.observe(process.resourceUsage().systemCPUTime / 1e6)
})

export const hashJobsStarted = meter.createCounter('app.hash.jobs.started', {
  description: 'Total number of hash jobs started'
})

export const hashJobsCompleted = meter.createCounter('app.hash.jobs.completed', {
  description: 'Total number of hash jobs completed successfully'
})

export const hashJobsFailed = meter.createCounter('app.hash.jobs.failed', {
  description: 'Total number of hash jobs that failed'
})

export const hashJobDurationSeconds = meter.createHistogram('app.hash.job.duration', {
  description: 'Time spent processing hash jobs',
  unit: 's'
})

export function startHashJobTimer(): () => void {
  const startedAt = process.hrtime.bigint()

  return () => {
    const elapsedNanoseconds = process.hrtime.bigint() - startedAt
    hashJobDurationSeconds.record(Number(elapsedNanoseconds) / 1e9)
  }
}

export function registerPoolMetrics(pool: PoolMetricsSource): void {
  meter.createObservableGauge('app.pool.queue.size', {
    description: 'Number of tasks waiting in the active worker pool queue'
  }).addCallback((result) => {
    result.observe(pool.queueSize)
  })

  meter.createObservableGauge('app.pool.threads.max', {
    description: 'Configured maximum number of workers in the active pool'
  }).addCallback((result) => {
    result.observe(pool.options.maxThreads)
  })

  meter.createObservableGauge('app.pool.tasks.completed', {
    description: 'Number of tasks completed by the active worker pool'
  }).addCallback((result) => {
    result.observe(pool.completed)
  })
}

export function registerJobQueueMetrics(readCounts: JobQueueMetricsReader): void {
  const waiting = meter.createObservableGauge('app.job_queue.waiting', {
    description: 'Number of jobs waiting in the external job queue'
  })
  const active = meter.createObservableGauge('app.job_queue.active', {
    description: 'Number of jobs active in the external job queue'
  })
  const completed = meter.createObservableGauge('app.job_queue.completed', {
    description: 'Number of retained completed jobs in the external job queue'
  })
  const failed = meter.createObservableGauge('app.job_queue.failed', {
    description: 'Number of retained failed jobs in the external job queue'
  })
  const delayed = meter.createObservableGauge('app.job_queue.delayed', {
    description: 'Number of delayed jobs in the external job queue'
  })

  meter.addBatchObservableCallback(async (result) => {
    try {
      const counts = await readCounts()
      result.observe(waiting, counts.waiting)
      result.observe(active, counts.active)
      result.observe(completed, counts.completed)
      result.observe(failed, counts.failed)
      result.observe(delayed, counts.delayed)
    } catch {
      return
    }
  }, [waiting, active, completed, failed, delayed])
}
