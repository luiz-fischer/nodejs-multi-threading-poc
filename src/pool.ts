import { cpus } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Piscina } from 'piscina';
import {
  hashJobsCompleted,
  hashJobsFailed,
  hashJobsStarted,
  registerPoolMetrics,
  startHashJobTimer
} from './metrics.js';

interface WorkerData {
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const piscina = new Piscina<WorkerData, WorkerMessage>({
  filename: resolve(__dirname, 'piscina-worker.js'),
  minThreads: 2,
  maxThreads: Math.max(4, cpus().length),
  idleTimeout: 30_000,
  resourceLimits: {
    maxOldGenerationSizeMb: 80
  }
});

registerPoolMetrics(piscina);

export async function hashWithPool(payload: string): Promise<string> {
  hashJobsStarted.add(1);
  const stopTimer = startHashJobTimer();

  try {
    const message = await piscina.run({ payload });

    if (message.status === 'ok') {
      hashJobsCompleted.add(1);
      stopTimer();
      return message.result;
    }

    throw new Error(message.message || 'Worker failed');
  } catch (error) {
    hashJobsFailed.add(1);
    stopTimer();
    throw error;
  }
}

export { piscina };
