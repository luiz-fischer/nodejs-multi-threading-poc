import { createHash } from 'node:crypto'
import {
  HASH_ALGORITHM,
  HASH_ENCODING,
  HASH_ROUNDS
} from './const.js'

export function hashPayload(payload: string): string {
  let hash = ''

  for (let round = 0; round < HASH_ROUNDS; round += 1) {
    hash = createHash(HASH_ALGORITHM)
      .update(payload, HASH_ENCODING)
      .digest('hex')
  }

  return hash
}
