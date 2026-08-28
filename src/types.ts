export type ExecutionMode = 'single-thread' | 'worker-thread' | 'piscina'

export interface ExecutionInfo {
  mode: ExecutionMode
  isMainThread: boolean
  threadId: number
  pid: number
  trackId: string
  hashRounds: number
}

export interface HashResult {
  hash: string
  execution: ExecutionInfo
}

export interface HashRequestBody {
  text: string
}

export interface EnvTypes {
  PORT: string
}

export interface WorkerData {
  payload: string
  trackId?: string
}

export interface PoolWorkerData {
  payload: string
  trackId: string
}

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
  taskId: string
  payload: string
  trackId: string
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
