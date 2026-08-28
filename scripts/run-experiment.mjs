import { mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import process from 'node:process'

const projectRoot = process.cwd()
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const requests = process.env.STRESS_REQUESTS ?? '1000'
const concurrency = process.env.STRESS_CONCURRENCY ?? '32'
const payloadBytes = process.env.STRESS_PAYLOAD_BYTES ?? '900000'
const requestTimeout = process.env.STRESS_TIMEOUT_MS ?? '30000'
const keepContainers = process.env.KEEP_CONTAINERS === 'true'

const scenarios = [
  {
    name: 'single-thread',
    port: 3011
  },
  {
    name: 'worker-thread',
    port: 3012
  },
  {
    name: 'piscina',
    port: 3013
  }
]

function runCommand(command, args, environment = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: environment,
      stdio: 'inherit'
    })

    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(`${command} ${args.join(' ')} stopped with code ${code ?? 'none'} and signal ${signal ?? 'none'}`))
    })
  })
}

async function waitForService(port) {
  const url = `http://127.0.0.1:${port}/non-blocking/`
  const deadline = Date.now() + 30_000
  let lastError = 'service did not return HTTP 200'

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }

    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  throw new Error(`Service at ${url} is not ready: ${lastError}`)
}

async function stopContainers() {
  await runCommand('docker', ['compose', 'down', '--remove-orphans'])
}

await mkdir('logs', { recursive: true })

let experimentError

try {
  await stopContainers()
  await runCommand('docker', ['compose', 'up', '--build', '--detach'])

  for (const scenario of scenarios) {
    await waitForService(scenario.port)
  }

  for (const scenario of scenarios) {
    const output = `logs/stress-${scenario.name}-${runId}.json`
    const environment = {
      ...process.env,
      BASE_URL: `http://127.0.0.1:${scenario.port}`,
      STRESS_MODE: scenario.name,
      STRESS_REQUESTS: requests,
      STRESS_CONCURRENCY: concurrency,
      STRESS_PAYLOAD_BYTES: payloadBytes,
      STRESS_TIMEOUT_MS: requestTimeout,
      STRESS_OUTPUT: output
    }

    console.log(`\nStarting ${scenario.name} test against port ${scenario.port}`)
    await runCommand(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'stress'], environment)
    console.log(`Completed ${scenario.name} test: ${output}`)
  }
} catch (error) {
  experimentError = error
} finally {
  if (!keepContainers) {
    try {
      await stopContainers()
    } catch (error) {
      console.error('Unable to stop Docker Compose services:', error)
      if (!experimentError) experimentError = error
    }
  }
}

if (experimentError) {
  throw experimentError
}

console.log('\nExperiment completed successfully')
console.log(`Reports: logs/stress-*-${runId}.json`)
console.log(`Containers kept running: ${keepContainers}`)
