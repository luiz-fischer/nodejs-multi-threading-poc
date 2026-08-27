import { createHash } from 'node:crypto';

interface WorkerData {
  payload: string;
}

interface WorkerMessage {
  status: 'ok' | 'error';
  result?: string;
  message?: string;
}

export default function hashWorker({ payload }: WorkerData): WorkerMessage {
  try {
    const result = createHash('sha256').update(payload, 'utf8').digest('hex');
    return { status: 'ok', result };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to hash payload';
    return { status: 'error', message };
  }
}
