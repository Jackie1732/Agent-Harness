import { copyFile, mkdir } from 'node:fs/promises'

// Static UI assets have a finite inventory independent of the Node compiler program.
const target = new URL('../dist/web/', import.meta.url)
await mkdir(target, { recursive: true })
for (const name of ['index.html', 'style.css', 'app.mjs', 'rpc.mjs', 'view.mjs', 'forms.mjs']) {
  await copyFile(new URL(`../src/web/${name}`, import.meta.url), new URL(name, target))
}
