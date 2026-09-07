// Container healthcheck: the web service is healthy when /healthz answers.

const port = process.env.INTERNAL_PORT || 8899;

try {
  const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
    signal: AbortSignal.timeout(4000),
  });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
