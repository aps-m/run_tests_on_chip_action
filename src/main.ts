import * as core from '@actions/core'
import { spawn, ChildProcess } from 'child_process'
import * as path from 'path'

// Глобальная ссылка на GDB процесс для обработки сигналов отмены
let gdbProcess: ChildProcess | null = null
let isAborted = false

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

    function processLine(line: string): void {
      if (line.startsWith('Pass [')) {
        console.log(`✅ ${line}`)
      } else if (line.startsWith('Fail [')) {
        console.error(`❌ ${line}`)
        failed_count++
      } else {
        console.log(line)
      }

      if (targetMessage !== '') {
        if (line.startsWith(targetMessage)) {
          console.log('Tag message was found!')
          targetMessageFound = true
          clearTimeout(timeoutHandle)
          gdb.kill()
        }
      } else if (line.startsWith('Transfer rate:')) {
        setTimeout((): void => {
          clearTimeout(timeoutHandle)
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
      clearTimeout(timeoutHandle)
      gdbProcess = null

      if (isAborted) {
        reject(new Error('Action was cancelled'))
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
      clearTimeout(timeoutHandle)
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

    const timeoutHandle = setTimeout(() => {
      console.log('Timeout error. Finishing process...')
      gdb.kill()
      reject(
        new Error(`Timeout error: process exceeded ${timeoutSeconds} seconds`)
      )
    }, timeoutSeconds * 1000)
  })
}
