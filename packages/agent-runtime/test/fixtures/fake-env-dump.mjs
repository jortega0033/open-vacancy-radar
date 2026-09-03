// Dumps the child process's own environment as a single JSON line (ADI-15). Deliberately reports
// the raw `process.env` rather than a filtered view: the whole point of the sentinel sweep is to
// see everything that actually reached the child, including anything the OS or process runtime
// added on its own after `spawnProcess` handed over its allowlisted set.
process.stdout.write(JSON.stringify({ ...process.env }) + '\n');
