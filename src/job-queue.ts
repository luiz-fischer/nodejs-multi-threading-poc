import PQueue from 'p-queue';
import { hashWithPool } from './pool.js';

const queue = new PQueue({ 
  concurrency: 8, 
  intervalCap: 100, 
  interval: 1000 
});

interface HashJob {
  text: string;
}

export function enqueueHashJob(job: HashJob): Promise<string> {
  return queue.add<string>(() => hashWithPool(job.text)).then((result) => {
    if (result === undefined) {
      throw new Error('Hash job was removed from the queue');
    }
    return result;
  });
}
