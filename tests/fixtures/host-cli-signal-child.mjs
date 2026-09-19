import { runHostCli } from '../../dist/host/index.js'

process.on('message', message => {
  if (message === 'SIGTERM' || message === 'SIGINT') process.emit(message)
})
process.exitCode = await runHostCli(['serve', '--config', process.argv[2]], {
  stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
})
process.disconnect()
