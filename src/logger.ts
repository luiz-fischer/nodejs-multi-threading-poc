import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
import { threadId } from 'node:worker_threads'
import { LOG_FILE } from './const.js'
import type { LogDetails, LogLevel } from './types.js'

if (LOG_FILE) {
  mkdirSync(dirname(LOG_FILE), { recursive: true })
}

export function writeLog(level: LogLevel, event: string, details: LogDetails = {}): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    pid: process.pid,
    threadId,
    ...details
  })

  process.stdout.write(`${line}\n`)
  if (LOG_FILE) {
    appendFileSync(LOG_FILE, `${line}\n`)
  }
}
