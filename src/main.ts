import * as core from '@actions/core'
import { spawn, ChildProcess } from 'child_process'
import * as path from 'path'

// Глобальная ссылка на GDB процесс для обработки сигналов отмены
let gdbProcess: ChildProcess | null = null
let isAborted = false

type TestResult = 'Pass' | 'Fail' | 'Skip'

const TEST_RESULT_ICONS: Record<TestResult, string> = {
  Pass: '✅',
  Fail: '❌',
  Skip: '⚠️'
}

const ESC = String.fromCharCode(27)
const TEST_RESULT_PREFIXES: readonly (readonly [string, TestResult])[] = [
  ['Pass [', 'Pass'],
  ['Fail [', 'Fail'],
  ['Skip [', 'Skip'],
  [`✅ ${ESC}[32mPass${ESC}[0m [`, 'Pass'],
  [`❌ ${ESC}[31mFail${ESC}[0m [`, 'Fail'],
  [`⚠️ ${ESC}[33mSkip${ESC}[0m [`, 'Skip']
]

const GDB_FATAL_ERROR_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [
    /unknown\/unexpected STLINK status code/i,
    'GDB/STLINK reported an unexpected status'
  ],
  [
    /^Program received signal SIG(?:TRAP|SEGV|BUS|ILL|ABRT|FPE)\b/,
    'Target stopped with a fatal signal'
  ],
  [/^Remote communication error\./, 'GDB remote communication failed'],
  [/^Remote connection closed\b/, 'GDB remote connection was closed']
]

export function getTestResult(line: string): TestResult | null {
  return (
    TEST_RESULT_PREFIXES.find(([prefix]) => line.startsWith(prefix))?.[1] ??
    null
  )
}

export function getGdbFatalError(line: string): string | null {
  const fatalError = GDB_FATAL_ERROR_PATTERNS.find(([pattern]) =>
    pattern.test(line)
  )

  return fatalError !== undefined ? `${fatalError[1]}: ${line}` : null
}

function hasTestResultIcon(line: string): boolean {
  return /^(?:✅|❌|⚠️?)/.test(line)
}

// Обработчик сигналов для немедленного завершения при отмене
function setupSignalHandlers(): void {
  const handleSignal = (signal: string): void => {
    console.log(`\nReceived ${signal} signal. Aborting...`)
    isAborted = true
    if (gdbProcess) {
      gdbProcess.kill('SIGKILL')
      gdbProcess = null
    }
    process.exit(1)
  }

  process.on('SIGINT', () => handleSignal('SIGINT'))
  process.on('SIGTERM', () => handleSignal('SIGTERM'))
}

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  // Настраиваем обработчики сигналов в начале
  setupSignalHandlers()

  try {
    const timeout = Number(core.getInput('timeout'))
    const gdb_target_host: string = core.getInput('gdb_target_host')
    const executableInput: string = core.getInput('executable')
    const wait_for_msg: string = core.getInput('wait_for_msg')

    // Валидация таймаута
    if (isNaN(timeout) || timeout <= 0) {
      throw new Error(
        `Invalid timeout value: ${timeout}. Must be a positive number.`
      )
    }

    const absolute_executable_path = path.resolve(executableInput)

    console.log('Started...')

    console.log(`Executable: ${executableInput}`)

    console.log(`Executable absolute: ${absolute_executable_path}`)

    await runGDBAndWaitForMessage(
      absolute_executable_path,
      wait_for_msg,
      gdb_target_host,
      timeout
    )

    console.log('Tests finished')

    console.log('Finished...')
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}

async function runGDBAndWaitForMessage(
  executablePath: string,
  targetMessage: string,
  gdbTargetHost: string,
  timeoutSeconds: number
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Проверяем, не был ли уже получен сигнал отмены
    if (isAborted) {
      reject(new Error('Action was cancelled'))
      return
    }

    const gdb = spawn('arm-none-eabi-gdb', [executablePath], {
      stdio: ['pipe', 'pipe', 'pipe']
    })

    // Сохраняем ссылку на процесс для обработчиков сигналов
    gdbProcess = gdb

    let stdoutBuffer = ''
    let stderrBuffer = ''
    let failed_count = 0
    let targetMessageFound = false
    let fatalError: Error | null = null
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null

    function stopGdbWithError(error: Error): void {
      if (fatalError !== null) {
        return
      }

      fatalError = error

      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle)
      }

      gdb.kill()
    }

    function processLine(line: string): void {
      const testResult = getTestResult(line)
      const gdbFatalError = getGdbFatalError(line)
      const formattedLine =
        testResult !== null && !hasTestResultIcon(line)
          ? `${TEST_RESULT_ICONS[testResult]} ${line}`
          : line

      if (gdbFatalError !== null) {
        console.error(formattedLine)
        stopGdbWithError(new Error(gdbFatalError))
        return
      } else if (testResult === 'Fail') {
        console.error(formattedLine)
        failed_count++
      } else {
        console.log(formattedLine)
      }

      if (targetMessage !== '') {
        if (line.startsWith(targetMessage)) {
          console.log('Tag message was found!')
          targetMessageFound = true
          if (timeoutHandle !== null) {
            clearTimeout(timeoutHandle)
          }
          gdb.kill()
        }
      } else if (line.startsWith('Transfer rate:')) {
        setTimeout((): void => {
          if (timeoutHandle !== null) {
            clearTimeout(timeoutHandle)
          }
          gdb.kill()
        }, 2000)
      }
    }

    function handleStreamData(buffer: string, chunk: Buffer): string {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const item of lines) {
        processLine(item)
      }

      return buffer
    }

    gdb.stdout.on('data', (data: Buffer) => {
      stdoutBuffer = handleStreamData(stdoutBuffer, data)
    })

    gdb.stderr.on('data', (data: Buffer) => {
      stderrBuffer = handleStreamData(stderrBuffer, data)
    })

    gdb.on('close', (code: number | null) => {
      console.log(`GDB finished with code: ${code}`)
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle)
      }
      gdbProcess = null

      if (isAborted) {
        reject(new Error('Action was cancelled'))
      } else if (fatalError !== null) {
        reject(fatalError)
      } else if (targetMessage !== '' && !targetMessageFound) {
        reject(new Error(`Target message "${targetMessage}" was not found`))
      } else if (failed_count > 0) {
        reject(new Error(`Failed tests count: ${failed_count}`))
      } else {
        resolve()
      }
    })

    gdb.on('error', (err: Error) => {
      console.error('Error while GDB was starting... error message:', err)
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle)
      }
      gdbProcess = null
      reject(err)
    })

    gdb.stdin.write(`target remote ${gdbTargetHost}\n`)
    gdb.stdin.write('set pagination off\n')
    gdb.stdin.write('load\n')

    if (targetMessage === '') {
      console.log('No message to wait for. Waiting elf file load finished...')
      gdb.stdin.write('monitor reset run\n')
      gdb.stdin.write('detach\n')
      gdb.stdin.write('exit\n')
    } else {
      console.log('Waiting for message:', targetMessage)
      gdb.stdin.write('monitor arm semihosting enable\n')
      gdb.stdin.write('monitor arm semihosting_fileio enable\n')
      gdb.stdin.write('continue\n')
    }

    timeoutHandle = setTimeout(() => {
      console.log('Timeout error. Finishing process...')
      stopGdbWithError(
        new Error(`Timeout error: process exceeded ${timeoutSeconds} seconds`)
      )
    }, timeoutSeconds * 1000)
  })
}
