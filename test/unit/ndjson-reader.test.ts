import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { NdjsonReader } from '../../src/ui/ndjson-reader';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('NdjsonReader payload blob indexing', () => {
  it('indexes payload blob records by event id and blob id without listing them as errors', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'errorcore-ndjson-'));
    tmpDirs.push(dir);
    const filePath = path.join(dir, 'captures.ndjson');

    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          schemaVersion: '1.2.0',
          eventId: 'evt-1',
          capturedAt: '2026-05-06T00:00:00.000Z',
          error: { type: 'Error', message: 'boom', stack: '' },
          request: { url: '/checkout' },
          ioTimeline: [
            {
              requestPayloadRef: {
                blobId: 'blob_1',
                storage: 'spool'
              }
            }
          ]
        }),
        JSON.stringify({
          schemaVersion: '1.2.0',
          kind: 'payload_blob',
          eventId: 'evt-1',
          blobId: 'blob_1',
          body: Buffer.from('payload').toString('base64'),
          bodyEncoding: 'base64'
        })
      ].join('\n') + '\n'
    );

    const reader = new NdjsonReader(filePath, null);

    expect(reader.getAll().total).toBe(1);
    expect(reader.getBlob('evt-1', 'blob_1')).toMatchObject({
      eventId: 'evt-1',
      blobId: 'blob_1',
      body: Buffer.from('payload').toString('base64')
    });
  });

  it('uses fingerprints when grouping top dashboard errors', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'errorcore-ndjson-'));
    tmpDirs.push(dir);
    const filePath = path.join(dir, 'captures.ndjson');

    fs.writeFileSync(
      filePath,
      [
        {
          schemaVersion: '1.2.0',
          eventId: 'evt-1',
          fingerprint: 'same-fingerprint',
          capturedAt: '2026-05-06T00:00:00.000Z',
          error: { type: 'PrismaError', message: 'failed at line 10', stack: '' },
          errorOrigin: { package: '@prisma/client' }
        },
        {
          schemaVersion: '1.2.0',
          eventId: 'evt-2',
          fingerprint: 'same-fingerprint',
          capturedAt: '2026-05-06T00:01:00.000Z',
          error: { type: 'PrismaError', message: 'failed at line 42', stack: '' },
          errorOrigin: { package: '@prisma/client' }
        }
      ].map((entry) => JSON.stringify(entry)).join('\n') + '\n'
    );

    const reader = new NdjsonReader(filePath, null);

    expect(reader.getStats().topErrors).toEqual([
      { message: 'PrismaError: failed at line 10', count: 2 }
    ]);
  });
});
