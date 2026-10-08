import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { realpath, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

async function packageFiles(entry, name) {
  let directory = dirname(entry)
  while (true) {
    const manifest = await readFile(join(directory, 'package.json'), 'utf8').then(JSON.parse).catch(error => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (manifest?.name === name) {
      if (name === 'yoga-layout') {
        assert.equal(manifest.license, 'MIT')
        assert.match(await readFile(entry, 'utf8'), /Copyright \(c\) Meta Platforms[\s\S]*MIT license/)
      } else await readFile(join(directory, name === 'ink' ? 'license' : 'LICENSE'))
      await readFile(join(directory, name === 'ink' ? 'readme.md' : 'README.md'))
      return { directory, version: manifest.version }
    }
    const parent = dirname(directory)
    assert.notEqual(parent, directory, `Package metadata missing for ${name}`)
    directory = parent
  }
}

/** Exercise the installed React/Ink/Yoga dependency closure and release the real Ink instance. */
export async function verifyTerminalConsumer(library, native = false) {
  const requireCore = createRequire(await realpath(join(library, 'package.json')))
  const inkEntry = requireCore.resolve('ink'), reactEntry = requireCore.resolve('react')
  const inkPackage = await packageFiles(inkEntry, 'ink'), reactPackage = await packageFiles(reactEntry, 'react')
  const requireInk = createRequire(join(inkPackage.directory, 'package.json'))
  const yogaEntry = requireInk.resolve('yoga-layout'), yogaPackage = await packageFiles(yogaEntry, 'yoga-layout')
  assert.equal(inkPackage.version, '8.0.0'); assert.equal(reactPackage.version, '19.3.0')
  const { createElement } = await import(pathToFileURL(reactEntry))
  const { render, renderToString, Text, useInput } = await import(pathToFileURL(inkEntry))
  const text = '仓库外 学习 Harness 👩‍💻 é'
  assert.ok((await renderToString(createElement(Text, null, text))).includes(text))
  let instance, frames = '', raw = []
  const stdin = native ? process.stdin : new PassThrough()
  const stdout = native ? process.stdout : new Writable({ write(chunk, _encoding, callback) { frames += chunk.toString(); callback() } })
  if (native) assert.ok(stdin.isTTY && stdout.isTTY, 'Native release smoke requires a real terminal')
  else {
    Object.assign(stdin, { isTTY: true, isRaw: false, setRawMode(value) { raw.push(value); this.isRaw = value; return this } })
    Object.assign(stdout, { isTTY: true, columns: 96, rows: 32 })
  }
  function App() {
    useInput((input, key) => { if (key.ctrl && input === 's') instance.unmount() })
    return createElement(Text, null, `${text}${native ? ' — Ctrl+S 释放终端' : ''}`)
  }
  try {
    instance = render(createElement(App), { stdin, stdout, stderr: stdout, interactive: true, exitOnCtrlC: false, patchConsole: false })
    await instance.waitUntilRenderFlush()
    if (!native) {
      assert.ok(frames.includes(text)); assert.ok(raw.includes(true))
      instance.unmount()
    }
    await instance.waitUntilExit()
    assert.notEqual(stdin.isRaw, true)
    if (!native) { assert.equal(raw.at(-1), false); assert.equal(stdin.listenerCount('readable'), 0) }
    return { node: process.version, ink: inkPackage.version, react: reactPackage.version, yoga: yogaPackage.version,
      rendered: text, rendererReleased: true, nativeTerminal: native, rawAfterUnmount: stdin.isRaw }
  } finally {
    instance?.unmount()
    if (!native) { stdin.destroy(); stdout.destroy() }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await verifyTerminalConsumer(process.argv[2], process.argv.includes('--native'))))
}
