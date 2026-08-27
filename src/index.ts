import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

interface HashRequestBody {
  text: string;
}

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

const app = express();
app.use(express.json({ limit: '1mb' }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const workerPath = join(__dirname, 'workers.js');

app.get('/non-blocking/', (_req: Request, res: Response) => {
  res.status(200).send('This page is non-blocking');
});

app.post('/api/hash', async (req: Request<unknown, unknown, Partial<HashRequestBody>>, res: Response, next) => {
  try {
    if (typeof req.body.text !== 'string') {
      res.status(400).json({ error: 'The "text" field must be a string' });
      return;
    }

    const hash = await runWorker({ payload: req.body.text });
    res.json({ hash });
  } catch (error) {
    next(error);
  }
});

function runWorker(workerData: WorkerData): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const worker = new Worker(workerPath, {
      workerData,
      resourceLimits: {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 4
      }
    });

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(new Error('Worker timeout'));
    }, 10_000);

    function safeResolve(value: string) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      worker.terminate();
      resolve(value);
    }

    function safeReject(error: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      worker.terminate();
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

const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  const message = error instanceof Error ? error.message : 'Internal server error';
  res.status(500).json({ error: message });
};

app.use(errorHandler);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`App listening on port ${port}`);
});
