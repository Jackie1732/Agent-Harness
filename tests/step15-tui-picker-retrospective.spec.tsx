import { Box, render } from 'ink'
import { expect, it } from 'vitest'
import { Picker } from '../src/tui/picker.js'
import { sendTui, tuiStreams } from './step15-tui-streams.js'

function picker(initial: readonly string[]) {
  const io = tuiStreams(), chosen: string[] = []
  const view = (items: readonly string[]) => <Box height={24} width={80} flexDirection="column"><Picker title="精确目标" items={items.map(value => ({ label: value, value }))}
    onSelect={value => chosen.push(value)} onCancel={() => undefined} /></Box>
  const instance = render(view(initial), { ...io, interactive: true, debug: true, exitOnCtrlC: false, patchConsole: false })
  return { io, instance, chosen, send: (data: string) => sendTui(io.stdin, instance, data), replace: async (items: readonly string[]) => {
    instance.rerender(view(items)); await instance.waitUntilRenderFlush()
  }, dispose: async () => { instance.unmount(); await instance.waitUntilExit(); io.destroy() } }
}

it('selects the first arriving target after navigation during an empty loading list', async () => {
  const f = picker([])
  try {
    await f.instance.waitUntilRenderFlush(); await f.send('\u001b[B'); await f.send('\r')
    expect(f.chosen).toEqual([])
    await f.replace(['实际目标']); await f.send('\r')
    expect(f.chosen).toEqual(['实际目标'])
    expect(f.io.stdout.frames).toContain('1/1')
  } finally { await f.dispose() }
})

it('uses the remaining target for display and Enter when a selected list shrinks', async () => {
  const f = picker(['原目标一', '原目标二', '原目标三'])
  try {
    await f.instance.waitUntilRenderFlush(); await f.send('\u001b[B'); await f.send('\u001b[B')
    f.io.stdout.frames = ''; await f.replace(['唯一目标']); await f.send('\r')
    expect(f.chosen).toEqual(['唯一目标'])
    expect(f.io.stdout.frames).toContain('1/1')
    expect(f.io.stdout.frames).not.toContain('3/1')
    await f.replace(['唯一目标', '后续目标']); await f.send('\r')
    expect(f.chosen).toEqual(['唯一目标', '唯一目标'])
  } finally { await f.dispose() }
})

it('retains a valid selection when more targets arrive and after boundary navigation', async () => {
  const f = picker(['目标一', '目标二'])
  try {
    await f.instance.waitUntilRenderFlush(); await f.send('\u001b[B')
    await f.replace(['目标一', '目标二', '目标三']); await f.send('\r')
    expect(f.chosen).toEqual(['目标二'])
    for (let count = 0; count < 4; count++) await f.send('\u001b[B')
    await f.send('\r'); expect(f.chosen).toEqual(['目标二', '目标三'])
  } finally { await f.dispose() }
})

it('applies every direction key delivered in one terminal input chunk', async () => {
  const f = picker(['目标一', '目标二', '目标三'])
  try {
    await f.instance.waitUntilRenderFlush(); await f.send('\u001b[B\u001b[B')
    await f.send('\r'); expect(f.chosen).toEqual(['目标三'])
    await f.send('\u001b[A\u001b[A')
    await f.send('\r'); expect(f.chosen).toEqual(['目标三', '目标一'])
  } finally { await f.dispose() }
})
