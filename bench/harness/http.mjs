export async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.headers ?? {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  let body = null;
  try {
    body = text.length === 0 ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, ok: response.ok, body, text };
}

export async function waitFor(name, fn, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 250;
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for ${name}; last=${last instanceof Error ? last.message : JSON.stringify(last)}`);
}
