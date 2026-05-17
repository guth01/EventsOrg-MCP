// src/patch-stdout.ts
// ─── STDOUT SAFETY VALVE ──────────────────────────────────────────────────────
// MCP requires that stdout ONLY contains JSON-RPC messages. Some libraries
// write directly to process.stdout bypassing console.log.
// We intercept process.stdout.write: if it looks like JSON, it goes to stdout.
// If it's plain text, it's forcibly redirected to stderr so Claude ignores it.

const originalStdoutWrite = process.stdout.write.bind(process.stdout);

(process.stdout as any).write = function (
  chunk: any,
  encoding?: any,
  cb?: any
) {
  const str = chunk.toString();
  if (str.trim().startsWith("{")) {
    return originalStdoutWrite(chunk, encoding, cb);
  }
  return process.stderr.write(chunk, encoding, cb);
};
