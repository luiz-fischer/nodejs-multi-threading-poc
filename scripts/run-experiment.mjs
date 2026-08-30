import { mkdir, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { get } from 'node:http'
import process from 'node:process'

const projectRoot = process.cwd()
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const requests = process.env.STRESS_REQUESTS ?? '1000'
const concurrency = process.env.STRESS_CONCURRENCY ?? '32'
const payloadBytes = process.env.STRESS_PAYLOAD_BYTES ?? '900000'
const requestTimeout = process.env.STRESS_TIMEOUT_MS ?? '120000'
const keepContainers = process.env.KEEP_CONTAINERS === 'true'
const reportPaths = []
const modeByFlag = Object.freeze({
  '-single': 'single-thread',
  '-multi': 'worker-thread',
  '-piscina': 'piscina'
})
const requestedFlags = process.argv.slice(2)

if (requestedFlags.length > 1) {
  throw new Error('Pass only one experiment flag: -single, -multi, or -piscina')
}

const requestedFlag = requestedFlags[0]
const selectedBruteForceMode = requestedFlag
  ? modeByFlag[requestedFlag]
  : undefined

if (requestedFlag && !selectedBruteForceMode) {
  throw new Error(
    `Unknown experiment flag: ${requestedFlag}. Use -single, -multi, or -piscina`
  )
}

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

async function waitForService(port) {
  const url = `http://127.0.0.1:${port}/non-blocking/`
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

async function stopContainers() {
  await runCommand('docker', ['compose', 'down', '--remove-orphans'])
}

async function runSequentialExperiment() {
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
      reportPaths.push(output)
      console.log(`Completed ${scenario.name} test: ${output}`)
    }

    const workloadContracts = await Promise.all(reportPaths.map(async (reportPath) => {
      const report = JSON.parse(await readFile(reportPath, 'utf8'))
      const result = report.results?.[0]

      if (!result?.hash || !result?.workload) {
        throw new Error(`Missing workload proof in ${reportPath}`)
      }

      return {
        scenario: result.endpoint,
        hash: result.hash,
        workload: result.workload
      }
    }))
    const uniqueContracts = new Set(
      workloadContracts.map(({ hash, workload }) => JSON.stringify({ hash, workload }))
    )

    if (uniqueContracts.size !== 1) {
      throw new Error(`Workload parity failed: ${JSON.stringify(workloadContracts)}`)
    }

    console.log(`\nWorkload parity validated: ${workloadContracts[0].workload.inputFingerprint}`)
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
}

if (selectedBruteForceMode) {
  console.log(`Selected experiment mode: ${selectedBruteForceMode}`)
  await runCommand(
    process.execPath,
    ['scripts/run-brute-force.mjs', selectedBruteForceMode],
    {
      ...process.env,
      BRUTE_FORCE_MODE: selectedBruteForceMode
    }
  )
} else {
  await runSequentialExperiment()
}
