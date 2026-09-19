import { createServer, request } from 'node:https'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Test-only authenticated forwarder drops the first completed receiver response. */
export async function ackLossProxy(certRoot, targetPort) {
  const [ca, cert, key, senderCert, senderKey] = await Promise.all([
    'ca.pem', 'server.pem', 'server-key.pem', 'client.pem', 'client-key.pem',
  ].map(name => readFile(join(certRoot, name))))
  let drop = true
  let droppedReceipt
  const server = createServer({ ca, cert, key, requestCert: true, rejectUnauthorized: true }, (incoming, response) => {
    const upstream = request({ hostname: '127.0.0.1', port: targetPort, servername: 'localhost', path: incoming.url,
      method: 'POST', headers: incoming.headers, ca, cert: senderCert, key: senderKey, rejectUnauthorized: true, agent: false }, result => {
      const chunks = []
      result.on('data', chunk => chunks.push(chunk))
      result.on('end', () => {
        const bytes = Buffer.concat(chunks)
        if (drop) {
          drop = false
          droppedReceipt = JSON.parse(bytes.toString('utf8')).outcome.receipt
          response.destroy()
        } else { response.writeHead(result.statusCode, result.headers); response.end(bytes) }
      })
    })
    upstream.on('error', () => response.destroy())
    incoming.pipe(upstream)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return {
    port: server.address().port,
    receipt: () => droppedReceipt,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}
