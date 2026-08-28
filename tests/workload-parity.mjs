import assert from 'node:assert/strict'
import { isMainThread, threadId } from 'node:worker_threads'
import process from 'node:process'

process.env.HASH_ROUNDS = '3'
process.env.WORKER_MAX_CONCURRENCY = '2'
process.env.PISCINA_MAX_THREADS = '2'

const [hashModule, workerModule, piscinaModule] = await Promise.all([
  import('../dist/hash.js'),
  import('../dist/worker.js'),
  import('../dist/pool.js')
])

const { createHashTask, executeHashTask } = hashModule
const { runWorker, shutdownWorkerPool } = workerModule
const { hashWithPool, shutdownPool } = piscinaModule

const payload = 'identical-payload-ç-漢字-'.repeat(2_000)
const trackId = '018f22e2-7f4c-7abc-8def-0123456789ab'
const task = createHashTask(payload, trackId)
const taskSnapshot = JSON.parse(JSON.stringify(task))

try {
  const singleThreadResult = executeHashTask(task, {
    mode: 'single-thread',
    isMainThread,
    threadId,
    pid: process.pid
  })
  const workerThreadResult = await runWorker(task)
  const piscinaResult = await hashWithPool(task)

  assert.deepEqual(task, taskSnapshot, 'An executor mutated the shared task input')
  assert.deepEqual(workerThreadResult.workload, singleThreadResult.workload)
  assert.deepEqual(piscinaResult.workload, singleThreadResult.workload)
  assert.equal(workerThreadResult.hash, singleThreadResult.hash)
  assert.equal(piscinaResult.hash, singleThreadResult.hash)

  assert.equal(singleThreadResult.execution.mode, 'single-thread')
  assert.equal(singleThreadResult.execution.isMainThread, true)
  assert.equal(singleThreadResult.execution.threadId, 0)
  assert.equal(workerThreadResult.execution.mode, 'worker-thread')
  assert.equal(workerThreadResult.execution.isMainThread, false)
  assert.ok(workerThreadResult.execution.threadId > 0)
  assert.equal(piscinaResult.execution.mode, 'piscina')
  assert.equal(piscinaResult.execution.isMainThread, false)
  assert.ok(piscinaResult.execution.threadId > 0)

  console.log('Workload parity validated for all processing modes')
  console.log(JSON.stringify({
    input: {
      algorithm: task.workload.algorithm,
      encoding: task.workload.encoding,
      rounds: task.workload.rounds,
      payloadBytes: singleThreadResult.workload.payloadBytes
    },
    hash: singleThreadResult.hash,
    inputFingerprint: singleThreadResult.workload.inputFingerprint,
    execution: {
      singleThread: singleThreadResult.execution.threadId,
      workerThread: workerThreadResult.execution.threadId,
      piscina: piscinaResult.execution.threadId
    }
  }, null, 2))
} finally {
  await Promise.all([
    shutdownWorkerPool(),
    shutdownPool()
  ])
}
