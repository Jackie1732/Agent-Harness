import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { render, renderToString } from 'ink'
import { DraftInput } from '../src/tui/input.js'
import { editDraft, graphemes, layoutDraft } from '../src/tui/draft.js'
import { displayValue, plainText } from '../src/tui/text.js'
import { powershellCommand, serviceCommandCards } from '../src/tui/command-cards.js'

class InputStream extends PassThrough {
  readonly isTTY = true
  readonly raw: boolean[] = []
  setRawMode(value: boolean) { this.raw.push(value); return this }
}
class OutputStream extends Writable {
  readonly isTTY = true
  columns = 80
  rows = 24
  frames = ''
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.frames += chunk.toString(); callback()
  }
}

describe('Step15 terminal input and display', () => {
  it('moves and deletes complete graphemes while preserving full-width cell columns', () => {
    let draft = { text: '中e\u0301👩‍🔬\nＡb', cursor: 3 }
    expect(graphemes(draft.text)).toEqual(['中', 'e\u0301', '👩‍🔬', '\n', 'Ａ', 'b'])
    draft = editDraft(draft, { kind: 'backspace' })
    expect(draft).toEqual({ text: '中e\u0301\nＡb', cursor: 2 })
    draft = editDraft(draft, { kind: 'down' })
    expect(draft.cursor).toBe(5)
    draft = editDraft(draft, { kind: 'up' })
    expect(draft.cursor).toBe(2)
    expect(editDraft(draft, { kind: 'delete' }).text).toBe('中e\u0301Ａb')
  })

  it('wraps cells around the cursor without mutating a draft on resize', () => {
    const draft = { text: '中文👩‍🔬e\u0301Ａ\n结束', cursor: 5 }
    const narrow = layoutDraft(draft, 4, 2), wide = layoutDraft(draft, 20, 8)
    expect(narrow.lines.every(line => !line.includes('\u001b'))).toBe(true)
    expect(wide.cursor).toEqual({ x: 9, y: 0 })
    expect(draft.text).toBe('中文👩‍🔬e\u0301Ａ\n结束')
  })

  it('renders Chinese fields and masks every secret frame', () => {
    const secret = 'credential-SENTINEL-中'
    const frame = renderToString(<DraftInput label="模型凭据" initial={secret} secret onConfirm={() => undefined} onCancel={() => undefined} />, { columns: 40 })
    expect(frame).toContain('模型凭据')
    expect(frame).not.toContain(secret)
    expect(frame).toContain('*'.repeat(graphemes(secret).length))
  })

  it('accepts bracketed paste literally, Enter inserts newline, Ctrl+S confirms and unmount restores raw mode', async () => {
    const stdin = new InputStream(), stdout = new OutputStream(), stderr = new OutputStream()
    const changes: string[] = [], confirmed: string[] = []
    const instance = render(<DraftInput label="任务" multiline onChange={text => changes.push(text)}
      onConfirm={text => confirmed.push(text)} onCancel={() => undefined} />, { stdin, stdout, stderr, exitOnCtrlC: false, patchConsole: false, interactive: true })
    const send = async (data: string) => { stdin.write(data); stdin.emit('readable'); await instance.waitUntilRenderFlush() }
    try {
      await instance.waitUntilRenderFlush()
      await send('\u001b[200~中文q\r\n👩‍🔬\u0013\u001b[201~')
      expect(confirmed).toEqual([])
      expect(changes.at(-1)).toBe('中文q\n👩‍🔬\u0013')
      await send('\r')
      expect(changes.at(-1)).toBe('中文q\n👩‍🔬\u0013\n')
      stdout.columns = 40; stdout.emit('resize'); await instance.waitUntilRenderFlush()
      await send('\u0013')
      expect(confirmed).toEqual(['中文q\n👩‍🔬\u0013\n'])
      await send('\u001b[200~甲\r乙\u001b[201~')
      expect(changes.at(-1)).toBe('中文q\n👩‍🔬\u0013\n甲\n乙')
    } finally {
      instance.unmount(); await instance.waitUntilExit(); stdin.destroy(); stdout.destroy(); stderr.destroy()
    }
    expect(stdin.raw[0]).toBe(true)
    expect(stdin.raw.at(-1)).toBe(false)
    expect(stdin.listenerCount('readable')).toBe(0)
  })

  it('removes terminal control sequences, redacts sentinels and keeps original results', () => {
    const original = '标题\u001b]52;c;YXNk\u0007\u001b[31m红\u001b[0m\u001b]8;;https://example.test\u0007链接\u001b]8;;\u0007\r\b\u009b2J\t\n秘密'
    const projection = plainText(original, ['秘密'])
    expect(projection).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/)
    expect(projection).not.toContain('秘密')
    expect(projection).toContain('    \n[hidden]')
    expect(original).toContain('\u001b]52')
    expect(displayValue({ text: '中文'.repeat(20) }, 20)).toContain('显示已截断')
    const escapedSecret = 'sentinel"\\\n中'
    expect(displayValue({ nested: escapedSecret }, 4096, [escapedSecret])).not.toContain(JSON.stringify(escapedSecret).slice(1, -1))
  })

  it('confirms coalesced ordinary field input and Enter without retaining CR in credentials', async () => {
    const stdin = new InputStream(), stdout = new OutputStream(), stderr = new OutputStream(), confirmed: string[] = []
    const instance = render(<DraftInput label="隐藏凭据" secret onConfirm={value => confirmed.push(value)} onCancel={() => undefined} />,
      { stdin, stdout, stderr, exitOnCtrlC: false, patchConsole: false, interactive: true })
    try {
      await instance.waitUntilRenderFlush(); stdin.write('abc\r'); stdin.emit('readable'); await instance.waitUntilRenderFlush()
      expect(confirmed).toEqual(['abc']); expect(stdout.frames).not.toContain('abc')
    } finally { instance.unmount(); await instance.waitUntilExit(); stdin.destroy(); stdout.destroy(); stderr.destroy() }
  })

  it('generates the exact original Automation operations with PowerShell literal quoting', () => {
    const cards = serviceCommandCards({ automation: "F:\\文件夹\\a'b.json", triggerKey: 'trigger:1', expectedToken: 'token' })
    expect(cards[1]!.argv).toEqual(['atomic-harness', 'automate', '--config', "F:\\文件夹\\a'b.json", '--acknowledge-run-unknown', 'trigger:1'])
    expect(cards[2]!.argv.slice(-4)).toEqual(['--unlock', '--predecessor-stopped', '--expected-token', 'token'])
    expect(powershellCommand(cards[0]!.argv)).toContain("'F:\\文件夹\\a''b.json'")
    expect(cards.every(card => !card.argv.includes('recover') && !card.argv.includes('check'))).toBe(true)
  })
})
