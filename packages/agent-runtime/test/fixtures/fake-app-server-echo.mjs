// Stands in for `codex app-server --stdio` for ManagedAppServerProcess tests: a long-lived
// process (does not exit on its own) that echoes each stdin line back on stdout, so `write()` ->
// `onStdout` wiring can be observed end to end. Writes one fixed line to stderr at startup so
// stderr redaction can be tested without a separate control protocol. Understands two control
// lines instead of echoing them: `EXIT:<code>` exits immediately with that code (to test the
// "process died unexpectedly" -> onFailure path), and `STDERR:<text>` writes <text> to stderr.
process.stderr.write('fixture stderr line 1\n');

let buffered = '';
process.stdin.on('data', (chunk) => {
  buffered += chunk.toString('utf8');
  let newline;
  while ((newline = buffered.indexOf('\n')) !== -1) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (line.startsWith('EXIT:')) {
      process.exit(Number(line.slice('EXIT:'.length)));
    } else if (line.startsWith('STDERR:')) {
      process.stderr.write(`${line.slice('STDERR:'.length)}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  }
});
