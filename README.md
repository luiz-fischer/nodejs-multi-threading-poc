# Node.js Multithreading Experiment

This project compares three ways of processing CPU-bound SHA-256 hashing in a Node.js API:

1. Synchronous single-thread execution on the main event loop
2. A reusable native worker pool built directly with `worker_threads`
3. A reusable worker pool managed by Piscina

The experiment measures throughput, latency, event loop responsiveness, memory, CPU usage, queue pressure, and thread identity for every request.

All three modes execute the same `executeHashTask` function with the same immutable workload contract:

```json
{
  "workload": {
    "payload": "same request content",
    "algorithm": "sha256",
    "encoding": "utf8",
    "rounds": 10
  },
  "trackId": "request UUIDv7"
}
```

Only the execution strategy changes: direct main-thread invocation, native worker-pool dispatch, or Piscina dispatch. Each response includes a deterministic `inputFingerprint` covering the payload hash and every workload parameter.

## Requirements

- Node.js 20 or later
- npm
- Docker Engine
- Docker Compose

Node.js 20 is used because the application starts OpenTelemetry with the `--import` option and uses the built-in `fetch` API.

## Install and build

```bash
npm install
npm run build
npm run typecheck
npm run test:workload-parity
```

## Run locally

The development command compiles TypeScript in watch mode and restarts the server when the compiled output changes:

```bash
npm run dev
```

The default local port is configured in `.env`:

```text
PORT=3001
```

## API endpoints

### Single-thread

```text
POST /api/singlethread/hash
```

Calculates the hash synchronously on the main event loop. The response must report:

```json
{
  "execution": {
    "mode": "single-thread",
    "isMainThread": true,
    "threadId": 0
  }
}
```

### Worker thread

```text
POST /api/hash
```

Uses the reusable Piscina pool and is the recommended multithreaded endpoint. The response must report `mode: "piscina"` and `isMainThread: false`.

### Native worker pool

```text
POST /api/raw-worker/hash
```

Submits the workload to BullMQ and returns immediately with HTTP `202`:

```json
{
  "jobId": "hash-019...",
  "trackId": "019...",
  "status": "waiting",
  "statusUrl": "/api/raw-worker/hash/hash-019...",
  "deduplicated": false
}
```

Read the result from the returned status URL:

```text
GET /api/raw-worker/hash/:jobId
```

The status endpoint returns `202` while the job is waiting or active, `200` with the hash result when completed, and `500` if every processing attempt fails. The stress runners perform this polling automatically and include the complete enqueue-to-result duration in latency measurements.

BullMQ stores only workload metadata in Redis. The 900,000-byte payload is written to the `bullmq-payloads` Docker volume and loaded only when one of the three native workers is available. The processor still invokes the same `executeHashTask` implementation used by the other modes.

Clients can send a UUIDv7 `Idempotency-Key` header. Repeated submissions with the same key return the existing BullMQ job instead of adding another one.

The native container limits worker V8 heaps, uses two glibc memory arenas, and keeps a single libuv helper thread. OpenTelemetry auto-instrumentations are loaded only when the span exporter is enabled. The CPU-bound hash is synchronous and does not use the libuv thread pool, so these settings reduce RSS without changing the workload or resource metrics.

### Piscina worker pool

```text
POST /api/pool/hash
```

Uses a reusable Piscina pool. The default Docker configuration limits the pool to five workers. The response reports the worker thread that processed the request.

### Health check

```text
GET /non-blocking/
```

This endpoint is used as an event loop responsiveness probe during the load test.

### OpenTelemetry resource snapshot

```text
GET /telemetry/resources
```

Returns the latest OpenTelemetry metric snapshot used by the load test. Prometheus is not required by this project.

## Docker experiment

The Compose file creates three isolated application services. Each application has four CPUs and a 512 MB memory limit. The native worker service also starts a Redis container limited to one CPU and 512 MB.

| Service | Host port | Target endpoint | Worker configuration |
| --- | ---: | --- | --- |
| `single-thread` | `3011` | `/api/singlethread/hash` | Main event loop only |
| `worker-thread` | `3012` | `/api/raw-worker/hash` | BullMQ feeding three reusable native workers |
| `piscina` | `3013` | `/api/hash` | Five reusable Piscina workers |

Redis uses AOF persistence with `maxmemory-policy=noeviction`. Queue data and pending payloads are kept in named Docker volumes.

Start the containers:

```bash
docker compose up --build -d
docker compose ps
```

Stop them:

```bash
docker compose down
```

## Full sequential experiment

Run the complete experiment with one command:

```bash
npm run experiment
```

The orchestrator rebuilds the Docker image, starts all three services, waits for their health checks, and runs the single-thread, worker-thread, and Piscina tests sequentially. The next test starts only after the previous test exits successfully.

Pass one flag after `--` to run only one service with the staged saturation profile:

```bash
npm run experiment -- -single
npm run experiment -- -multi
npm run experiment -- -piscina
```

`-multi` selects the reusable native `worker_threads` pool. The `--` separator is required so npm forwards the flag to the experiment script.

Configure the workload with environment variables:

```bash
STRESS_REQUESTS=2000 \
STRESS_CONCURRENCY=32 \
HASH_ROUNDS=10 \
npm run experiment
```

Containers are stopped after the experiment by default. Keep them running for inspection with:

```bash
KEEP_CONTAINERS=true npm run experiment
```

Both worker pool implementations are initialized lazily, so the single-thread container does not create worker threads unless a multithreaded endpoint is called.

## Stress test

Run one scenario at a time against its isolated container:

```bash
STRESS_MODE=single-thread \
BASE_URL=http://127.0.0.1:3011 \
STRESS_OUTPUT=logs/stress-single.json \
npm run stress
```

```bash
STRESS_MODE=worker-thread \
BASE_URL=http://127.0.0.1:3012 \
STRESS_OUTPUT=logs/stress-worker.json \
npm run stress
```

```bash
STRESS_MODE=piscina \
BASE_URL=http://127.0.0.1:3013 \
STRESS_OUTPUT=logs/stress-piscina.json \
npm run stress
```

The default workload is:

- 1,000 total requests
- 32 concurrent clients
- 900,000-byte payload
- 120-second request timeout

Each request performs ten SHA-256 rounds over the full payload by default. Configure this with `HASH_ROUNDS` when a heavier or lighter CPU workload is required.

Apply a custom round count when starting the containers:

```bash
HASH_ROUNDS=20 docker compose up --build -d
```

Override the workload when needed:

```bash
STRESS_MODE=piscina \
BASE_URL=http://127.0.0.1:3013 \
STRESS_REQUESTS=5000 \
STRESS_CONCURRENCY=64 \
STRESS_PAYLOAD_BYTES=900000 \
npm run stress
```

The test validates every successful response. It fails if:

- the reported execution mode is wrong
- a single-thread request leaves the main thread
- a worker request runs on the main thread
- a `trackId` is missing, invalid, or duplicated
- fewer than two Piscina worker threads are observed
- the payload hash or workload fingerprint differs from the shared contract
- algorithm, encoding, rounds, or UTF-8 payload size differs between modes
- repeated native submissions with the same `Idempotency-Key` produce different jobs

The full experiment also compares the JSON reports after all scenarios finish. It exits with an error unless all three reports contain the same hash and workload fingerprint.

## Selectable brute-force saturation test

The brute-force runner starts only one Docker Compose service and increases concurrent clients in stages. Run it through the experiment command with one processing flag:

```bash
npm run experiment -- -multi
```

Select any one processing mode:

```bash
npm run experiment -- -multi
npm run experiment -- -single
npm run experiment -- -piscina
```

The native pool is selected by `-multi`. The direct environment-variable form remains available for automation:

```bash
BRUTE_FORCE_MODE=worker-thread npm run brute-force
```

By default, the runner tests concurrency levels from 16 through 1,024, keeps each stage active for 10 seconds, and sends the same 900,000-byte workload used by the comparison test. It records successful throughput, attempted throughput, p50, p95, p99, health-probe p95, CPU utilization, RSS, heap, event loop lag, queue depth, errors, thread IDs, and UUIDv7 uniqueness.

The run stops when one of these conditions is observed:

- RSS reaches 90% of the 512 MB container limit
- Completed requests reach a 1% error rate
- The service becomes unavailable
- The configured concurrency ceiling is completed
- A response violates the execution or shared-workload contract

Customize the ramp and limits when needed:

```bash
BRUTE_FORCE_MODE=worker-thread \
BRUTE_FORCE_CONCURRENCY_STEPS=32,64,128,256,384,512 \
BRUTE_FORCE_STAGE_DURATION_MS=15000 \
BRUTE_FORCE_RSS_LIMIT_PERCENT=95 \
BRUTE_FORCE_MAX_ERROR_RATE_PERCENT=2 \
npm run experiment -- -multi
```

For the native mode, BullMQ holds the backlog externally while only three jobs are dispatched to the in-process worker pool. The reported queue depth is therefore the BullMQ waiting count instead of an in-memory payload queue.

To run the load generator against an already-running service without managing Docker:

```bash
BRUTE_FORCE_MODE=worker-thread \
BASE_URL=http://127.0.0.1:3012 \
npm run brute-force:load
```

This test intentionally drives a service toward saturation. The default 90% RSS guard reduces the chance of a hard OOM kill, but a fast allocation spike can still reach the Docker memory limit. The test is isolated to the selected 512 MB container, and the generated report records Docker's `OOMKilled` state. Keep the container after the run for inspection with `KEEP_CONTAINERS=true`.

## Reports and logs

The stress test writes a JSON report with:

- Throughput
- p50, p95, and p99 latency
- `/non-blocking/` probe latency
- OpenTelemetry resource samples
- Peak heap, RSS, CPU, event loop lag, native pool size, and BullMQ waiting count
- Process IDs and observed worker thread IDs

Application logs are written as newline-delimited JSON:

```text
logs/single-thread/server.ndjson
logs/worker-thread/server.ndjson
logs/piscina/server.ndjson
```

Inspect the reports with:

```bash
jq . logs/stress-single.json
jq . logs/stress-worker.json
jq . logs/stress-piscina.json
```

The Docker `json-file` logging driver is also enabled. Export combined Compose logs when needed:

```bash
docker compose logs --no-color --timestamps > logs/docker-compose.log
```

Per-request application logging is disabled by default because file I/O changes benchmark results. Enable it only for diagnostic runs:

```bash
LOG_REQUESTS=true docker compose up --build -d
```

Brute-force runs also save one JSON report and one timestamped container log:

```text
logs/brute-force-worker-thread-<run-id>.json
logs/brute-force-worker-thread-<run-id>.container.log
```

## Interpreting thread identity

The `execution` object is the proof of where each hash was calculated:

- Single-thread: `isMainThread: true`, `threadId: 0`
- Worker thread: `isMainThread: false`, a positive `threadId`
- Piscina: `isMainThread: false`, a small reusable set of thread IDs

The native worker-thread endpoint and Piscina should both report only the configured pool workers repeatedly. A `trackId` is unique per job and is propagated through `AsyncLocalStorage`, BullMQ metadata, worker data, and Piscina tasks.

## Observability

OpenTelemetry is initialized before the application code and provides:

- Automatic HTTP and Express instrumentation
- Request spans with `request.start` and `request.end` events
- UUIDv7 request correlation through `trackId`
- Event loop lag metrics
- Heap, current and maximum RSS, CPU, native worker-pool metrics, and BullMQ job counts

The Docker benchmark disables console exporters to reduce measurement noise while retaining the OpenTelemetry in-memory resource snapshots used by the stress test.

## Project structure

```text
src/index.ts              Express API and execution metadata
src/worker.ts             Native worker pool facade and metrics
src/worker-pool.ts        Reusable worker_threads pool
src/workers.ts            Raw worker-thread implementation
src/bullmq.ts             BullMQ producer, consumer, payload spool, and job status
src/pool.ts               Lazy Piscina pool
src/piscina-worker.ts     Piscina task implementation
src/instrumentation.ts    OpenTelemetry SDK setup
src/metrics.ts            OpenTelemetry instruments
src/track-context.ts      AsyncLocalStorage and UUIDv7 tracking
src/types.ts              Shared TypeScript types
src/const.ts              Shared constants and configuration
tests/stress.mjs          Load test and JSON report generator
tests/brute-force.mjs     Selectable staged saturation load generator
scripts/run-brute-force.mjs  Single-service Docker saturation orchestrator
docker-compose.yml        Isolated benchmark services
```
