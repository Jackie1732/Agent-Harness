import { render } from 'ink'
import { expect, it } from 'vitest'
import type { JsonValue } from '../src/foundation/json.js'
import { TreeEditor } from '../src/tui/tree.js'
import { sendTui, tuiStreams } from './step15-tui-streams.js'

it('masks raw and JSON escaped credentials in tree rows while confirming the original value', async () => {
  const secret = 'SECRET"\\\n中', original = { credential: `before ${secret} after` }, values: JsonValue[] = [], io = tuiStreams()
  const instance = render(<TreeEditor title="完整字段" initial={original} secrets={[secret]} maxTextBytes={65536}
    onSubmit={value => values.push(value)} onCancel={() => undefined} />, { ...io, interactive: true, exitOnCtrlC: false, patchConsole: false })
  try {
    await instance.waitUntilRenderFlush()
    for (const data of ['\u001b[B', '\r', '\u0013', '\u0013', '\r']) await sendTui(io.stdin, instance, data)
    expect(io.stdout.frames).not.toContain(secret)
    expect(io.stdout.frames).not.toContain(JSON.stringify(secret).slice(1, -1))
    expect(io.stderr.frames).not.toContain(secret)
    expect(io.stderr.frames).not.toContain(JSON.stringify(secret).slice(1, -1))
    expect(values).toEqual([original])
  } finally { instance.unmount(); await instance.waitUntilExit(); io.destroy() }
})
