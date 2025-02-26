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
    // const ms: string = core.getInput('milliseconds')
    const timeout: number = Number(core.getInput('timeout'))
    const gdb_target_host: string = core.getInput('gdb_target_host')
    const executable: string = core.getInput('executable')

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

        function processLine(line: string, isError: boolean) {
          if (line.startsWith('Pass')) {
            console.log(line)
          } else if (line.startsWith('Fail')) {
            // line.includes("pass")
            console.error(line)
          }

          if (line.startsWith(targetMessage)) {
            console.log('Tag message was found!')
            clearTimeout(timeoutHandle)
            gdb.kill()
            resolve()
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
          stderrBuffer = handleStreamData(stderrBuffer, data, false)
        })

        gdb.stderr.on('data', data => {
          stdoutBuffer = handleStreamData(stdoutBuffer, data, true)
        })

        gdb.on('close', code => {
          console.log(`GDB finished with code: ${code}`)
          gdb.stdin.write(`exit\n`)
          gdb.stdin.write(`y\n`)
          resolve()
        })

        gdb.on('error', err => {
          console.error('Error while GDB was starting... error message:', err)
          reject(err)
        })

        gdb.stdin.write(`target remote ${gdb_target_host}\n`)
        gdb.stdin.write(`set pagination off\n`)
        gdb.stdin.write(`load\n`)
        gdb.stdin.write(`monitor arm semihosting enable\n`)
        gdb.stdin.write(`monitor arm semihosting_fileio enable\n`)
        gdb.stdin.write(`continue\n`)

        let timeoutHandle = setTimeout(() => {
          console.log('Timeout error. Finishing process...')
          gdb.stdin.write(`exit\n`)
          gdb.stdin.write(`y\n`)
          gdb.kill() // Завершаем процесс GDB
          reject(new Error('Timeout error'))
        }, timeout * 1000)
      })
    }

    const messageToWaitFor = 'Test complited'

    await runGDBAndWaitForMessage(absolute_executable_path, messageToWaitFor)
      .then(() => console.log('Tests finished'))
      .catch(err => console.error('Error:', err))

    // await awaiter

    console.log('Finished...')
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}
