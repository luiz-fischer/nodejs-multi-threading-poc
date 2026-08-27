import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import {
  hashJobsCompleted,
  hashJobsFailed,
  hashJobsStarted,
  startHashJobTimer
} from './metrics.js';

const WORKER_PATH = fileURLToPath(new URL('./workers.js', import.meta.url));
const MAX_TASKS_PER_WORKER = 1000;

export interface WorkerData {
  payload: string;
}

interface WorkerSuccessMessage {
  status: 'ok';
  result: string;
}

interface WorkerErrorMessage {
  status: 'error';
  message: string;
}

type WorkerMessage = WorkerSuccessMessage | WorkerErrorMessage;

export function runWorker(workerData: WorkerData): Promise<string> {
  hashJobsStarted.add(1);
  const stopTimer = startHashJobTimer();

  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const worker = new Worker(WORKER_PATH, {
      workerData,
      resourceLimits: {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 4
      }
    });

    const timeout = setTimeout(() => {
      if (settled) return;
      safeReject(new Error('Worker timeout'));
    }, 10_000);

    function safeResolve(value: string) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      worker.terminate();
      hashJobsCompleted.add(1);
      stopTimer();
      resolve(value);
    }

    function safeReject(error: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      worker.terminate();
      hashJobsFailed.add(1);
      stopTimer();
      reject(error);
    }

    worker.once('message', (message: WorkerMessage) => {
      if (message.status === 'ok') {
        safeResolve(message.result);
      } else {
        safeReject(new Error(message.message));
      }
    });

    worker.once('error', (error: Error) => {
      safeReject(error);
    });

    worker.once('exit', (code: number) => {
      if (code !== 0) {
        safeReject(new Error(`Worker exited with code ${code}`));
      }
    });
  });
}

export function runWorkerWithTimeout(workerData: WorkerData, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, { workerData });
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error('Worker timeout'));
    }, timeoutMs);

    worker.once('message', (message) => {
      clearTimeout(timeout);
      resolve(message);
      worker.terminate();
    });

    worker.once('error', (error) => {
      clearTimeout(timeout);
      worker.terminate();
      reject(error);
    });
  });
}


const workerTaskCounts = new WeakMap();

export function createRecyclableWorker(workerPath: string, workerData: WorkerData): Worker {
  const worker = new Worker(workerPath, { workerData });
  workerTaskCounts.set(worker, 0);
  return worker;
}

export function recordWorkerTask(worker: Worker) {
  const current = workerTaskCounts.get(worker) ?? 0;
  const next = current + 1;
  workerTaskCounts.set(worker, next);

  if (next >= MAX_TASKS_PER_WORKER) {
    worker.terminate();
    workerTaskCounts.delete(worker);
  }
}
