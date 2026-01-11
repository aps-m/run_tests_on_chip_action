import * as core from '@actions/core'
import { wait } from './wait'
import { spawn } from 'child_process'
import * as path from 'path'

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const timeout: number = Number(core.getInput('timeout'))
    const gdb_target_host: string = core.getInput('gdb_target_host')
    const executable: string = core.getInput('executable')
    const wait_for_msg: string = core.getInput('wait_for_msg')

    // Валидация таймаута
    if (isNaN(timeout) || timeout <= 0) {
      throw new Error(
        `Invalid timeout value: ${timeout}. Must be a positive number.`
      )
    }

    const absolute_executable_path = path.resolve(executable)

    console.log('Started...')

    console.log(`Executable: ${executable}`)

    console.log(`Executable absolute: ${absolute_executable_path}`)

    async function runGDBAndWaitForMessage(
      executable: string,
      targetMessage: string
    ) {
      return new Promise<void>((resolve, reject) => {
        const gdb = spawn('arm-none-eabi-gdb', [executable], {
          stdio: ['pipe', 'pipe', 'pipe']
        })

        let stdoutBuffer = ''
        let stderrBuffer = ''

        let failed_count = 0
        let targetMessageFound = false

        function processLine(line: string, isError: boolean) {
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
          } else {
            if (line.startsWith('Transfer rate:')) {
              setTimeout(() => {
                clearTimeout(timeoutHandle)
                gdb.kill()
              }, 2000)
            }
          }
        }

        function handleStreamData(
          buffer: string,
          chunk: Buffer,
          isError: boolean
        ) {
          buffer += chunk.toString()
          let lines = buffer.split('\n')
          buffer = lines.pop() || '' // Оставляем незавершённую строку
          lines.forEach(item => {
            processLine(item, isError)
          })
          return buffer
        }

        gdb.stdout.on('data', data => {
          stdoutBuffer = handleStreamData(stdoutBuffer, data, false)
        })

        gdb.stderr.on('data', data => {
          stderrBuffer = handleStreamData(stderrBuffer, data, true)
        })

        gdb.on('close', code => {
          console.log(`GDB finished with code: ${code}`)
          clearTimeout(timeoutHandle)

          if (targetMessage !== '' && !targetMessageFound) {
            reject(new Error(`Target message "${targetMessage}" was not found`))
          } else if (failed_count > 0) {
            reject(new Error(`Failed tests count: ${failed_count}`))
          } else {
            resolve()
          }
        })

        gdb.on('error', err => {
          console.error('Error while GDB was starting... error message:', err)
          clearTimeout(timeoutHandle)
          reject(err)
        })

        gdb.stdin.write(`target remote ${gdb_target_host}\n`)
        gdb.stdin.write(`set pagination off\n`)
        gdb.stdin.write(`load\n`)

        if (wait_for_msg === '') {
          console.log(
            'No message to wait for. Waiting elf file load finished...'
          )
          gdb.stdin.write(`monitor reset run\n`)
          gdb.stdin.write(`detach\n`)
          gdb.stdin.write(`exit\n`)
        } else {
          console.log('Waiting for message:', wait_for_msg)
          gdb.stdin.write(`monitor arm semihosting enable\n`)
          gdb.stdin.write(`monitor arm semihosting_fileio enable\n`)
          gdb.stdin.write(`continue\n`)
        }

        const timeoutHandle = setTimeout(() => {
          console.log('Timeout error. Finishing process...')
          gdb.kill()
          reject(
            new Error(`Timeout error: process exceeded ${timeout} seconds`)
          )
        }, timeout * 1000)
      })
    }

    await runGDBAndWaitForMessage(absolute_executable_path, wait_for_msg)
      .then(() => {
        console.log('Tests finished')
      })
      .catch(err => {
        console.error('Error:', err)
        core.setFailed(err.message)
      })

    console.log('Finished...')
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}
