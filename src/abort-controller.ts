import { Worker } from 'node:worker_threads';

export function runCancelableTask(workerPath: string, workerData: unknown, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData });

    signal.addEventListener('abort', () => {
      worker.terminate();
      reject(new Error('Task aborted'));
    });

    worker.once('message', (message) => {
      resolve(message);
      worker.terminate();
    });

    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Exit code: ${code}`));
    });
  });
}