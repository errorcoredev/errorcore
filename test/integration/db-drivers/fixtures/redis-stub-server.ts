import net from 'node:net';

/**
 * A microscopic Redis-compatible server. Implements just enough of
 * RESP-2 to satisfy ioredis's connection handshake and the small command
 * set used by the patch tests:
 *   AUTH, HELLO, PING, SET, GET, DEL, INFO, QUIT, COMMAND, CLIENT, SELECT
 *
 * Not a full Redis. We do not maintain any persistent state across
 * commands beyond a single in-memory Map. Connections are accepted on
 * a free port and the test binds ioredis to it.
 */
export interface StubServer {
  port: number;
  close(): Promise<void>;
  authAttempts: string[];
  helloAttempts: string[];
}

export async function startRedisStub(): Promise<StubServer> {
  const data = new Map<string, string>();
  const authAttempts: string[] = [];
  const helloAttempts: string[] = [];

  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('binary');
      // RESP arrays are framed as: *<n>\r\n$<len>\r\n<bulk>\r\n...
      // We parse iteratively, peeling off complete frames.
      while (true) {
        const parsed = parseRespArray(buffer);
        if (parsed === null) break;
        buffer = parsed.rest;
        const [cmd, ...args] = parsed.parts;
        const cmdUpper = (cmd ?? '').toUpperCase();

        if (cmdUpper === 'AUTH') {
          authAttempts.push(args[args.length - 1] ?? '');
          socket.write('+OK\r\n');
        } else if (cmdUpper === 'HELLO') {
          // HELLO [protover] [AUTH username password]
          // The password is the last arg when AUTH is present.
          const authIdx = args.findIndex((a) => a.toUpperCase() === 'AUTH');
          const password = authIdx >= 0 ? args[authIdx + 2] ?? '' : '';
          helloAttempts.push(password);
          // Minimal HELLO response: empty map (RESP2 returns empty array).
          socket.write('*0\r\n');
        } else if (cmdUpper === 'PING') {
          socket.write('+PONG\r\n');
        } else if (cmdUpper === 'SET') {
          data.set(args[0] ?? '', args[1] ?? '');
          socket.write('+OK\r\n');
        } else if (cmdUpper === 'GET') {
          const v = data.get(args[0] ?? '');
          if (v === undefined) {
            socket.write('$-1\r\n');
          } else {
            socket.write(`$${Buffer.byteLength(v)}\r\n${v}\r\n`);
          }
        } else if (cmdUpper === 'DEL') {
          let removed = 0;
          for (const k of args) {
            if (data.delete(k)) removed += 1;
          }
          socket.write(`:${removed}\r\n`);
        } else if (cmdUpper === 'INFO') {
          const body = '# Server\r\nredis_version:6.0.0\r\n';
          socket.write(`$${Buffer.byteLength(body)}\r\n${body}\r\n`);
        } else if (cmdUpper === 'QUIT') {
          socket.write('+OK\r\n');
          socket.end();
        } else if (cmdUpper === 'COMMAND') {
          // ioredis pings COMMAND on connect to discover the dialect.
          // Empty array satisfies the discovery branch.
          socket.write('*0\r\n');
        } else if (cmdUpper === 'CLIENT') {
          // CLIENT SETNAME / CLIENT GETNAME / CLIENT ID — return OK / a
          // bulk string. ioredis sends CLIENT SETNAME at handshake.
          const sub = (args[0] ?? '').toUpperCase();
          if (sub === 'SETNAME') {
            socket.write('+OK\r\n');
          } else if (sub === 'GETNAME') {
            socket.write('$-1\r\n');
          } else if (sub === 'ID') {
            socket.write(':1\r\n');
          } else {
            socket.write('+OK\r\n');
          }
        } else if (cmdUpper === 'SELECT') {
          socket.write('+OK\r\n');
        } else {
          socket.write(`-ERR unknown command '${cmdUpper}'\r\n`);
        }
      }
    });
    socket.on('error', () => undefined);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('redis stub did not bind');
  }
  return {
    port: address.port,
    authAttempts,
    helloAttempts,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

interface ParsedFrame {
  parts: string[];
  rest: string;
}

function parseRespArray(buf: string): ParsedFrame | null {
  if (buf.length === 0 || buf[0] !== '*') return null;
  const headerEnd = buf.indexOf('\r\n');
  if (headerEnd === -1) return null;
  const count = parseInt(buf.slice(1, headerEnd), 10);
  if (Number.isNaN(count) || count < 0) return null;
  let cursor = headerEnd + 2;
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    if (buf[cursor] !== '$') return null;
    const lenEnd = buf.indexOf('\r\n', cursor);
    if (lenEnd === -1) return null;
    const len = parseInt(buf.slice(cursor + 1, lenEnd), 10);
    if (Number.isNaN(len) || len < 0) return null;
    const dataStart = lenEnd + 2;
    if (buf.length < dataStart + len + 2) return null;
    parts.push(buf.slice(dataStart, dataStart + len));
    cursor = dataStart + len + 2;
  }
  return { parts, rest: buf.slice(cursor) };
}
