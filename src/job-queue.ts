import PQueue from 'p-queue'
import { hashWithPool } from './pool.js'
import {
  JOB_QUEUE_CONCURRENCY,
  JOB_QUEUE_INTERVAL_CAP,
  JOB_QUEUE_INTERVAL_MS
} from './const.js'
import { createHashTask } from './hash.js'
import { createUuidV7, getRequestContext } from './track-context.js'
import type { HashJob, HashResult } from './types.js'

const queue = new PQueue({
  concurrency: JOB_QUEUE_CONCURRENCY,
  intervalCap: JOB_QUEUE_INTERVAL_CAP,
  interval: JOB_QUEUE_INTERVAL_MS
})

export function enqueueHashJob(job: HashJob): Promise<HashResult> {
  const trackId = job.trackId ?? getRequestContext()?.trackId ?? createUuidV7()

  return queue.add<HashResult>(() => hashWithPool(createHashTask(job.text, trackId))).then((result) => {
    if (result === undefined) {
      throw new Error('Hash job was removed from the queue')
    }
    return result
  })
}
