import {
  HASH_ALGORITHM,
  HASH_ENCODING,
  HASH_ROUNDS
} from './const.js'
import type {
  HashTask,
  HashWorkloadInput
} from './types.js'

export {
  executeHashTask,
  executeHashWorkload
} from './hash-workload.js'

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
