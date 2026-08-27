import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';

import { ALL_ENVS } from './config-env.js';
import { hashWithPool, piscina } from './pool.js';
import { runWorker } from './worker.js';
import { shutdownTelemetry } from './instrumentation.js';

interface HashRequestBody {
  text: string;
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/non-blocking/', (_req: Request, res: Response) => {
  res.status(200).send('This page is non-blocking');
});

// Comparação single-thread: o hash é calculado no event loop principal.
app.post('/api/singlethread/hash', async (req: Request<unknown, unknown, Partial<HashRequestBody>>, res: Response, next) => {
  const { text } = req.body;

  if (typeof text !== 'string' || text.length > 1_000_000) {
    res.status(400).json({ error: 'The "text" field must be a string with at most 1 MB' });
    return;
  }

  try {
    const hash = createHash('sha256').update(text, 'utf8').digest('hex');
    res.json({ hash });
  } catch (error) {
    next(error);
  }
});

app.post('/api/pool/hash', async (req, res, next) => {
  try {
    const hash = await hashWithPool(req.body.text);
    res.json({ hash });
  } catch (error) {
    next(error);
  }
});

app.post('/api/hash', async (req: Request<unknown, unknown, Partial<HashRequestBody>>, res: Response, next) => {
  if (!req.body.text || req.body.text.length > 1_000_000) {
    return res.status(400).json({ error: 'Payload too large' });
  }
 
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


const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  const message = error instanceof Error ? error.message : 'Internal server error';
  res.status(500).json({ error: message });
};

app.use(errorHandler);

const port = Number(ALL_ENVS.PORT ?? 3000);
const server = app.listen(port, () => {
  console.log(`App listening on port ${port}`);
});

let shuttingDown = false;

async function shutdown(exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  try {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }

    await piscina.destroy();
    await shutdownTelemetry();
  } catch (error) {
    console.error('Error during shutdown:', error);
    exitCode = 1;
  }

  process.exitCode = exitCode;
}

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use`);
  } else {
    console.error('Server error:', error);
  }
  void shutdown(1);
});

process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
