import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LocalEventStore } from '../../src/transport/local-event-store';

const dirs: string[] = [];

function tempStorePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'errorcore-local-store-'));
  dirs.push(dir);
  return path.join(dir, 'events.ndjson');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('LocalEventStore', () => {
  it('appends parseable local event records for error and payload blob envelopes', () => {
    const store = new LocalEventStore(tempStorePath());

    const first = store.append({
      kind: 'error',
      serialized: JSON.stringify({ eventId: 'evt-1', error: { message: 'boom' } })
    });
    const second = store.append({
      kind: 'payload_blob',
      serialized: JSON.stringify({ kind: 'payload_blob', eventId: 'evt-1', blobId: 'blob_1' })
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(store.readAll()).toEqual([
      expect.objectContaining({ id: first, payloadKind: 'error' }),
      expect.objectContaining({ id: second, payloadKind: 'payload_blob' })
    ]);
  });

  it('removes acknowledged ids by rewriting the file', () => {
    const store = new LocalEventStore(tempStorePath());
    const keep = store.append({ serialized: '{"eventId":"keep"}' });
    const remove = store.append({ serialized: '{"eventId":"remove"}' });

    store.remove([remove!]);

    expect(store.readAll().map((record) => record.id)).toEqual([keep]);
  });

  it('returns null and warns instead of throwing when writes fail', () => {
    const warnings: string[] = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'errorcore-local-store-dir-'));
    dirs.push(dir);
    const store = new LocalEventStore(dir, {
      onInternalWarning: (warning) => {
        warnings.push(warning.code);
        throw new Error('user warning callback failed');
      }
    });

    expect(store.append({ serialized: '{"eventId":"evt"}' })).toBeNull();
    expect(warnings).toEqual(['EC_LOCAL_EVENT_STORE_WRITE_FAILED']);
  });
});
