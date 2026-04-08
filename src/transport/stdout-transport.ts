
import fs = require('node:fs');

let warnedAboutStdoutTransport = false;

function warnAboutStdoutTransport(): void {
  if (warnedAboutStdoutTransport) {
    return;
  }

  warnedAboutStdoutTransport = true;
  console.warn(
    '[ErrorCore] Stdout transport writes captured payloads to application logs; use it only for local development or controlled pipelines.'
  );
}

export class StdoutTransport {
  public async send(payload: string | Buffer): Promise<void> {
    warnAboutStdoutTransport();
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(
        Buffer.isBuffer(payload) ? Buffer.concat([payload, Buffer.from('\n')]) : `${payload}\n`,
        (error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        }
      );
    });
  }

  public async flush(): Promise<void> {
    return Promise.resolve();
  }

  public async shutdown(): Promise<void> {
    return Promise.resolve();
  }

  public sendSync(payload: string): void {
    warnAboutStdoutTransport();
    try {
      fs.writeSync(1, `${payload}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try { fs.writeSync(2, `[ErrorCore] Stdout sync write failed: ${message}\n`); } catch { }
    }
  }
}
