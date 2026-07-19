import { spawn } from 'node:child_process'

export interface DockerResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Run the `docker` CLI. Deliberately not a daemon-socket client library: fewer
 * moving parts, trivially debuggable, and "no magic" — what we run is what a
 * user could run by hand.
 */
export function docker(
  args: string[],
  options: { onStdoutLine?: (line: string) => void; onStderrLine?: (line: string) => void } = {},
): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      options.onStdoutLine?.(chunk.toString().trimEnd())
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      options.onStderrLine?.(chunk.toString().trimEnd())
    })
    child.on('error', (err) =>
      reject(new Error(`failed to run docker (is it installed and on PATH?): ${err.message}`)),
    )
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

/** Run docker and throw (with stderr in the message) on a non-zero exit. */
export async function dockerOk(
  args: string[],
  context: string,
  options?: Parameters<typeof docker>[1],
): Promise<DockerResult> {
  const result = await docker(args, options)
  if (result.code !== 0) {
    throw new Error(`${context}: docker ${args[0]} exited ${result.code}: ${result.stderr.trim()}`)
  }
  return result
}

export async function imageExists(ref: string): Promise<boolean> {
  return (await docker(['image', 'inspect', ref])).code === 0
}
