import { createHash } from 'node:crypto'
import {
  HASH_ALGORITHM,
  HASH_ENCODING,
  HASH_ROUNDS
} from './const.js'
import type {
  ExecutionRuntime,
  HashResult,
  HashTask,
  HashWorkloadInput,
  HashWorkloadResult
} from './types.js'

export function createHashTask(payload: string, trackId: string): HashTask {
  const workload: HashWorkloadInput = Object.freeze({
    payload,
    algorithm: HASH_ALGORITHM,
    encoding: HASH_ENCODING,
    rounds: HASH_ROUNDS
  })

  return Object.freeze({
    workload,
    trackId
  })
}

export function executeHashWorkload(workload: HashWorkloadInput): HashWorkloadResult {
  if (workload.algorithm !== HASH_ALGORITHM || workload.encoding !== HASH_ENCODING) {
    throw new Error('Unsupported hash workload algorithm or encoding')
  }

  if (!Number.isSafeInteger(workload.rounds) || workload.rounds < 1) {
    throw new Error('Hash workload rounds must be a positive integer')
  }

  const payload = Buffer.from(workload.payload, workload.encoding)
  let digest = ''

  for (let round = 0; round < workload.rounds; round += 1) {
    const hash = createHash(workload.algorithm)
    hash.update(payload)
    digest = hash.digest('hex')
  }

  const fingerprintSource = JSON.stringify({
    algorithm: workload.algorithm,
    encoding: workload.encoding,
    rounds: workload.rounds,
    payloadBytes: payload.byteLength,
    payloadHash: digest
  })
  const inputFingerprint = createHash(workload.algorithm)
    .update(fingerprintSource, workload.encoding)
    .digest('hex')

  return {
    hash: digest,
    workload: {
      algorithm: workload.algorithm,
      encoding: workload.encoding,
      rounds: workload.rounds,
      payloadBytes: payload.byteLength,
      inputFingerprint
    }
  }
}

export function executeHashTask(
  task: HashTask,
  runtime: ExecutionRuntime
): HashResult {
  return {
    ...executeHashWorkload(task.workload),
    execution: {
      ...runtime,
      trackId: task.trackId,
      hashRounds: task.workload.rounds
    }
  }
}
