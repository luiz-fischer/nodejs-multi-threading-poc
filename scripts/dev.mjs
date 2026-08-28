import { spawn } from 'node:child_process'
import { existsSync, watch } from 'node:fs'
import { resolve } from 'node:path'
import { DEV_RESTART_DEBOUNCE_MS } from '../dist/const.js'

const projectRoot = process.cwd()
const distPath = resolve(projectRoot, 'dist')
const compilerPath = resolve(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsc.cmd' : 'tsc'
)

let server
let restartTimer
let restartRequested = false
let shuttingDown = false

function spawnServer() {
  server = spawn(process.execPath, ['--import', './dist/instrumentation.js', 'dist/index.js'], {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit'
  })

  server.once('exit', (code, signal) => {
    server = undefined
    if (restartRequested && !shuttingDown) {
      restartRequested = false
      spawnServer()
      return
    }

    if (!shuttingDown && code !== 0) {
      console.error(`Server stopped (code=${code ?? 'none'}, signal=${signal ?? 'none'})`)
    }
  })
}

function restartServer() {
  restartRequested = true
  if (server) {
    server.kill('SIGTERM')
  } else {
    restartRequested = false
    spawnServer()
  }
}

function scheduleRestart() {
  clearTimeout(restartTimer)
  restartTimer = setTimeout(restartServer, DEV_RESTART_DEBOUNCE_MS)
}

const compiler = spawn(compilerPath, ['--watch', '--preserveWatchOutput'], {
  cwd: projectRoot,
  env: process.env,
  stdio: 'inherit',
  shell: process.platform === 'win32'
})

const distWatcher = watch(distPath, scheduleRestart)
const envWatcher = existsSync(resolve(projectRoot, '.env'))
  ? watch(resolve(projectRoot, '.env'), scheduleRestart)
  : undefined

spawnServer()

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  clearTimeout(restartTimer)
  distWatcher.close()
  envWatcher?.close()
  compiler.kill('SIGTERM')
  server?.kill('SIGTERM')
}

process.once('SIGINT', () => {
  shutdown()
  process.exit(0)
})

process.once('SIGTERM', () => {
  shutdown()
  process.exit(0)
})
