import type { Worker } from 'node:worker_threads'

export type ExecutionMode = 'single-thread' | 'worker-thread' | 'piscina'
export type HashAlgorithm = 'sha256'
export type HashEncoding = 'utf8'

export interface ExecutionRuntime {
  readonly mode: ExecutionMode
  readonly isMainThread: boolean
  readonly threadId: number
  readonly pid: number
}

export interface ExecutionInfo extends ExecutionRuntime {
  readonly trackId: string
  readonly hashRounds: number
}

export interface HashWorkloadInput {
  readonly payload: string
  readonly algorithm: HashAlgorithm
  readonly encoding: HashEncoding
  readonly rounds: number
}

export interface HashTask {
  readonly workload: HashWorkloadInput
  readonly trackId: string
}

export interface HashWorkloadProof {
  readonly algorithm: HashAlgorithm
  readonly encoding: HashEncoding
  readonly rounds: number
  readonly payloadBytes: number
  readonly inputFingerprint: string
}

export interface HashWorkloadResult {
  readonly hash: string
  readonly workload: HashWorkloadProof
}

export interface HashResult extends HashWorkloadResult {
  execution: ExecutionInfo
}

export type HashTaskExecutor = (task: HashTask) => HashResult | Promise<HashResult>

export interface HashRequestBody {
  text: string
}

export interface EnvTypes {
  PORT: string
}

export type WorkerData = HashTask
export type PoolWorkerData = HashTask

export interface WorkerSuccessMessage {
  status: 'ok'
  result: HashResult
}

export interface WorkerErrorMessage {
  status: 'error'
  message: string
}

export type WorkerMessage = WorkerSuccessMessage | WorkerErrorMessage

export interface WorkerPoolTask {
  readonly taskId: string
  readonly hashTask: HashTask
}

export interface PendingWorkerPoolTask {
  readonly task: WorkerPoolTask
  readonly resolve: (result: HashResult) => void
  readonly reject: (error: Error) => void
}

export interface WorkerPoolSlot {
  readonly worker: Worker
  task?: PendingWorkerPoolTask
}

export interface WorkerPoolSuccessMessage {
  taskId: string
  status: 'ok'
  result: HashResult
}

export interface WorkerPoolErrorMessage {
  taskId: string
  status: 'error'
  message: string
}

export type WorkerPoolMessage = WorkerPoolSuccessMessage | WorkerPoolErrorMessage

export interface RequestContext {
  trackId: string
  startedAt: bigint
}

export interface HashJob {
  text: string
  trackId?: string
}

export interface PoolMetricsSource {
  readonly queueSize: number
  readonly completed: number
  readonly options: {
    readonly maxThreads: number
  }
}

export interface MetricPoint {
  value?: unknown
}

export interface ExportedMetric {
  descriptor?: {
    name?: string
  }
  dataPoints?: MetricPoint[]
}

export interface TelemetrySnapshot {
  timestamp: string
  metrics: Record<string, number[]>
}

export type LogLevel = 'info' | 'error'

export interface LogDetails {
  [key: string]: unknown
}
