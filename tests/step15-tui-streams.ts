import { PassThrough, Writable } from 'node:stream'
import type { Instance } from 'ink'

export class TuiInput extends PassThrough {
  readonly isTTY = true
  readonly raw: boolean[] = []
  setRawMode(value: boolean) { this.raw.push(value); return this }
}
export class TuiOutput extends Writable {
  readonly isTTY = true
  columns = 96
  rows = 32
  frames = ''
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.frames += chunk.toString(); callback()
  }
}
export function tuiStreams() {
  const stdin = new TuiInput(), stdout = new TuiOutput(), stderr = new TuiOutput()
  return { stdin, stdout, stderr, destroy: () => { stdin.destroy(); stdout.destroy(); stderr.destroy() } }
}
export async function sendTui(stdin: TuiInput, instance: Instance, data: string) {
  stdin.write(data); stdin.emit('readable'); await instance.waitUntilRenderFlush()
}
export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
