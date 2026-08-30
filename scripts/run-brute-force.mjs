import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { get } from 'node:http'
import process from 'node:process'

const projectRoot = process.cwd()
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const keepContainers = process.env.KEEP_CONTAINERS === 'true'
const selectedMode = process.argv[2] ?? process.env.BRUTE_FORCE_MODE ?? 'worker-thread'

const scenarios = {
  'single-thread': {
    service: 'single-thread',
    container: 'node-worker-single-thread',
    port: 3011
  },
  'worker-thread': {
    service: 'worker-thread',
    container: 'node-worker-thread',
    port: 3012,
    logServices: ['worker-thread', 'redis']
  },
  piscina: {
    service: 'piscina',
    container: 'node-worker-piscina',
    port: 3013
  }
}

const scenario = scenarios[selectedMode]

if (!scenario) {
  throw new Error(`Unknown brute-force mode: ${selectedMode}`)
}

function maximumConfiguredConcurrency() {
  const rawSteps = process.env.BRUTE_FORCE_CONCURRENCY_STEPS ?? '16,32,64,96,128,192,256,384,512,768,1024'
  const values = rawSteps
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isSafeInteger(value) && value > 0)

  return Math.max(64, ...values)
}

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

      reject(new Error(
        `${command} ${args.join(' ')} stopped with code ${code ?? 'none'} and signal ${signal ?? 'none'}`
      ))
    })
  })
}

function captureCommand(command, args, environment = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve(stdout)
        return
      }

      reject(new Error(
        `${command} ${args.join(' ')} stopped with code ${code ?? 'none'} and signal ` +
        `${signal ?? 'none'}: ${stderr.trim()}`
      ))
    })
  })
}

function getStatusCode(url, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Health check timed out after ${timeoutMs} ms`))
    })
    request.once('error', reject)
  })
}

async function waitForService() {
  const url = `http://127.0.0.1:${scenario.port}/non-blocking/`
  const deadline = Date.now() + 30_000
  let lastError = 'service did not return HTTP 200'

  while (Date.now() < deadline) {
    try {
      const statusCode = await getStatusCode(url)
      if (statusCode >= 200 && statusCode < 300) return
      lastError = `HTTP ${statusCode}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }

    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  throw new Error(`Service at ${url} is not ready: ${lastError}`)
}

async function stopContainers(environment) {
  await runCommand('docker', ['compose', 'down', '--remove-orphans'], environment)
}

const maximumConcurrency = maximumConfiguredConcurrency()
const outputPath = process.env.BRUTE_FORCE_OUTPUT ??
  `logs/brute-force-${selectedMode}-${runId}.json`
const containerLogPath = `logs/brute-force-${selectedMode}-${runId}.container.log`
const environment = {
  ...process.env,
  BRUTE_FORCE_MODE: selectedMode,
  BRUTE_FORCE_OUTPUT: outputPath,
  BASE_URL: `http://127.0.0.1:${scenario.port}`,
  WORKER_MAX_QUEUE: process.env.WORKER_MAX_QUEUE ?? String(maximumConcurrency),
  PISCINA_MAX_QUEUE: process.env.PISCINA_MAX_QUEUE ?? String(maximumConcurrency)
}

await mkdir('logs', { recursive: true })

let executionError
let containerState
let cleanupCompleted = false

try {
  await stopContainers(environment)
  console.log(`Starting only the ${scenario.service} service`)
  await runCommand(
    'docker',
    ['compose', 'up', '--build', '--detach', scenario.service],
    environment
  )
  await waitForService()

  console.log(`Running ${selectedMode} brute-force test against port ${scenario.port}`)
  await runCommand(
    process.execPath,
    ['tests/brute-force.mjs', selectedMode],
    environment
  )
} catch (error) {
  executionError = error
} finally {
  try {
    const dockerLogs = await captureCommand(
      'docker',
      [
        'compose',
        'logs',
        '--no-color',
        '--timestamps',
        ...(scenario.logServices ?? [scenario.service])
      ],
      environment
    )
    await writeFile(containerLogPath, dockerLogs)
  } catch (error) {
    console.error('Unable to save container logs:', error)
  }

  try {
    const rawState = await captureCommand(
      'docker',
      ['inspect', scenario.container, '--format', '{{json .State}}'],
      environment
    )
    containerState = JSON.parse(rawState.trim())
  } catch (error) {
    console.error('Unable to inspect the container state:', error)
  }

  if (!keepContainers) {
    try {
      await stopContainers(environment)
      cleanupCompleted = true
    } catch (error) {
      console.error('Unable to stop Docker Compose services:', error)
      if (!executionError) executionError = error
    }
  }

  try {
    const report = JSON.parse(await readFile(outputPath, 'utf8'))
    report.container = {
      name: scenario.container,
      stateBeforeCleanup: containerState,
      cleanupCompleted,
      keptRunning: keepContainers,
      logPath: containerLogPath
    }
    await writeFile(outputPath, JSON.stringify(report, null, 2))
  } catch (error) {
    console.error('Unable to append the container state to the JSON report:', error)
  }
}

if (executionError) throw executionError

console.log('\nBrute-force execution completed')
console.log(`JSON report: ${outputPath}`)
console.log(`Container log: ${containerLogPath}`)
console.log(`Container OOM killed: ${containerState?.OOMKilled ?? 'unknown'}`)
console.log(`Container kept running: ${keepContainers}`)
