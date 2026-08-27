import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';

interface WorkerData {
    payload: string;
}

if (!parentPort) {
    throw new Error('Worker parent port is not available');
}

try {
    const { payload } = workerData as WorkerData;
    const result = hashBuffer(payload);
    parentPort.postMessage({ status: 'ok', result });
} catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to hash payload';
    parentPort.postMessage({ status: 'error', message });
}

function hashBuffer(payload: string): string {
    const hash = createHash('sha256');
    hash.update(payload, 'utf8');
    return hash.digest('hex');
}
