import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { NodeSDK } from '@opentelemetry/sdk-node'
import {
  AggregationTemporality,
  ConsoleMetricExporter,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader
} from '@opentelemetry/sdk-metrics'
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node'
import {
  OTEL_METRIC_EXPORT_INTERVAL_MS
} from './const.js'
import type { ExportedMetric, MetricPoint, TelemetrySnapshot } from './types.js'

class LatestMetricExporter extends InMemoryMetricExporter {
  export(...args: Parameters<InMemoryMetricExporter['export']>): void {
    this.reset()
    super.export(...args)
  }
}

const memoryMetricExporter = new LatestMetricExporter(
  AggregationTemporality.CUMULATIVE
)
const memoryMetricReader = new PeriodicExportingMetricReader({
  exporter: memoryMetricExporter,
  exportIntervalMillis: OTEL_METRIC_EXPORT_INTERVAL_MS
})

const sdk = new NodeSDK({
  traceExporter: new ConsoleSpanExporter(),
  metricReaders: [
    new PeriodicExportingMetricReader({
      exporter: new ConsoleMetricExporter()
    }),
    memoryMetricReader
  ],
  instrumentations: [getNodeAutoInstrumentations()]
})

sdk.start()

export async function getTelemetrySnapshot(): Promise<TelemetrySnapshot> {
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
  await sdk.shutdown()
}
