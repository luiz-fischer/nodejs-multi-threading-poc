import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import type { RequestContext } from './types.js'

const storage = new AsyncLocalStorage<RequestContext>()

export function createUuidV7(): string {
  const bytes = randomBytes(16)
  let timestamp = BigInt(Date.now())

  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn)
    timestamp >>= 8n
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore()
}

export function runWithRequestContext<T>(context: RequestContext, callback: () => T): T {
  return storage.run(context, callback)
}
