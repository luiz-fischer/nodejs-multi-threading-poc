import { NodeSDK } from '@opentelemetry/sdk-node'
import {
  AggregationTemporality,
  ConsoleMetricExporter,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader
} from '@opentelemetry/sdk-metrics'
import { ConsoleSpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node'
import { isMainThread } from 'node:worker_threads'
import {
  OTEL_CONSOLE_EXPORTER_ENABLED,
  OTEL_METRIC_EXPORT_INTERVAL_MS
} from './const.js'
import type { ExportedMetric, MetricPoint, TelemetrySnapshot } from './types.js'

class LatestMetricExporter extends InMemoryMetricExporter {
  export(...args: Parameters<InMemoryMetricExporter['export']>): void {
    this.reset()
    super.export(...args)
  }
}

const memoryMetricExporter = isMainThread
  ? new LatestMetricExporter(AggregationTemporality.CUMULATIVE)
  : undefined
const memoryMetricReader = memoryMetricExporter
  ? new PeriodicExportingMetricReader({
      exporter: memoryMetricExporter,
      exportIntervalMillis: OTEL_METRIC_EXPORT_INTERVAL_MS
    })
  : undefined
const metricReaders = memoryMetricReader ? [memoryMetricReader] : []
const instrumentations = OTEL_CONSOLE_EXPORTER_ENABLED
  ? [(await import('@opentelemetry/auto-instrumentations-node')).getNodeAutoInstrumentations()]
  : []

if (OTEL_CONSOLE_EXPORTER_ENABLED && isMainThread) {
  metricReaders.unshift(new PeriodicExportingMetricReader({
    exporter: new ConsoleMetricExporter()
  }))
}

const sdk = isMainThread
  ? new NodeSDK({
      spanProcessors: OTEL_CONSOLE_EXPORTER_ENABLED
        ? [new SimpleSpanProcessor(new ConsoleSpanExporter())]
        : [],
      metricReaders,
      instrumentations
    })
  : undefined

sdk?.start()

export async function getTelemetrySnapshot(): Promise<TelemetrySnapshot> {
  if (!memoryMetricReader || !memoryMetricExporter) {
    return {
      timestamp: new Date().toISOString(),
      metrics: {}
    }
  }

  await memoryMetricReader.forceFlush()

  const exportedMetrics = memoryMetricExporter.getMetrics()
  const latestExport = exportedMetrics.at(-1)
  const snapshot: TelemetrySnapshot = {
    timestamp: new Date().toISOString(),
    metrics: {}
  }

  if (!latestExport) return snapshot

  for (const scopeMetrics of latestExport.scopeMetrics) {
    for (const metric of scopeMetrics.metrics as ExportedMetric[]) {
      const values = (metric.dataPoints ?? [])
        .map((point) => point.value)
        .filter((value): value is number | bigint =>
          typeof value === 'number' || typeof value === 'bigint'
        )
        .map((value) => Number(value))

      const name = metric.descriptor?.name
      if (name && values.length > 0) {
        snapshot.metrics[name] = values
      }
    }
  }

  return snapshot
}

export async function shutdownTelemetry(): Promise<void> {
  await sdk?.shutdown()
}
