import { createRequire } from 'node:module';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileTransport } from '../../src/transport/file-transport';

const nodeRequire = createRequire(import.meta.url);
const fs = nodeRequire('node:fs') as typeof import('node:fs');
const path = nodeRequire('node:path') as typeof import('node:path');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FileTransport', () => {
  describe('constructor', () => {
    it('defaults maxSizeBytes to 100 MB', () => {
      const transport = new FileTransport({ path: '/tmp/test.log' });
      // Trigger rotation to observe the threshold: stat returns a size just under 100 MB
      const statSpy = vi.spyOn(fs, 'stat').mockImplementation((_path, callback) => {
        (callback as Function)(null, { size: 100 * 1024 * 1024 });
      });
      const appendSpy = vi.spyOn(fs, 'appendFile').mockImplementation((_path, _data, callback) => {
        (callback as Function)();
      });

      // size === maxSizeBytes means no rotation (condition is <=)
      return transport.send('test').then(() => {
        expect(statSpy).toHaveBeenCalled();
        expect(appendSpy).toHaveBeenCalled();
      });
    });

    it('defaults maxBackups to 5', () => {
      const transport = new FileTransport({ path: '/tmp/test.log' });

      // Set up an oversized file to trigger rotation + cleanup
      vi.spyOn(fs, 'stat').mockImplementation((_path, callback) => {
        (callback as Function)(null, { size: 200 * 1024 * 1024 });
      });
      vi.spyOn(fs, 'rename').mockImplementation((_oldPath, _newPath, callback) => {
        (callback as Function)();
      });
      vi.spyOn(fs, 'appendFile').mockImplementation((_path, _data, callback) => {
        (callback as Function)();
      });

      const backupFiles = [
        'test.log.1000.bak',
        'test.log.2000.bak',
        'test.log.3000.bak',
        'test.log.4000.bak',
        'test.log.5000.bak',
        'test.log.6000.bak',
        'test.log.7000.bak'
      ];
      vi.spyOn(fs, 'readdir').mockImplementation((_dir, callback) => {
        (callback as Function)(null, backupFiles);
      });
      const unlinkSpy = vi.spyOn(fs, 'unlink').mockImplementation((_path, callback) => {
        (callback as Function)();
      });

      return transport.send('test').then(() => {
        // 7 backups sorted reverse: 7000,6000,5000,4000,3000,2000,1000
        // slice(5) removes the 2 oldest: 2000 and 1000
        expect(unlinkSpy).toHaveBeenCalledTimes(2);
      });
    });

    it('accepts custom maxSizeBytes and maxBackups', () => {
      const transport = new FileTransport({
        path: '/tmp/test.log',
        maxSizeBytes: 512,
        maxBackups: 2
      });

      vi.spyOn(fs, 'stat').mockImplementation((_path, callback) => {
        (callback as Function)(null, { size: 1024 });
      });
      vi.spyOn(fs, 'rename').mockImplementation((_oldPath, _newPath, callback) => {
        (callback as Function)();
      });
      vi.spyOn(fs, 'appendFile').mockImplementation((_path, _data, callback) => {
        (callback as Function)();
      });

      const backupFiles = [
        'test.log.1000.bak',
        'test.log.2000.bak',
        'test.log.3000.bak',
        'test.log.4000.bak'
      ];
      vi.spyOn(fs, 'readdir').mockImplementation((_dir, callback) => {
        (callback as Function)(null, backupFiles);
      });
      const unlinkSpy = vi.spyOn(fs, 'unlink').mockImplementation((_path, callback) => {
        (callback as Function)();
      });

      return transport.send('test').then(() => {
        // 4 backups, maxBackups=2, so 2 oldest are deleted
        expect(unlinkSpy).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('send', () => {
    it('appends a string payload with a trailing newline', async () => {
      const transport = new FileTransport({ path: '/tmp/test.log' });

      vi.spyOn(fs, 'stat').mockImplementation((_path, callback) => {
        (callback as Function)({ code: 'ENOENT' });
      });
      const appendSpy = vi.spyOn(fs, 'appendFile').mockImplementation((_path, _data, callback) => {
        (callback as Function)();
      });

      await transport.send('hello world');

      expect(appendSpy).toHaveBeenCalledWith(
        '/tmp/test.log',
        'hello world\n',
        expect.any(Function)
      );
    });

    it('appends a Buffer payload with a trailing newline', async () => {
      const transport = new FileTransport({ path: '/tmp/test.log' });

      vi.spyOn(fs, 'stat').mockImplementation((_path, callback) => {
        (callback as Function)({ code: 'ENOENT' });
      });
      const appendSpy = vi.spyOn(fs, 'appendFile').mockImplementation((_path, _data, callback) => {
        (callback as Function)();
      });

      const payload = Buffer.from('binary data');
      await transport.send(payload);

      const expected = Buffer.concat([payload, Buffer.from('\n')]);
      const actualData = appendSpy.mock.calls[0][1] as Buffer;
      expect(Buffer.isBuffer(actualData)).toBe(true);
      expect(actualData.equals(expected)).toBe(true);
    });

    it('warns and rethrows on appendFile error', async () => {
      const transport = new FileTransport({ path: '/tmp/test.log' });

      vi.spyOn(fs, 'stat').mockImplementation((_path, callback) => {
        (callback as Function)({ code: 'ENOENT' });
      });
      vi.spyOn(fs, 'appendFile').mockImplementation((_path, _data, callback) => {
        (callback as Function)(new Error('disk full'));
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await expect(transport.send('data')).rejects.toThrow('disk full');
      expect(warnSpy).toHaveBeenCalledWith(
        '[ErrorCore] File transport dropped payload: disk full'
      );
    });

    it('warns and rethrows on non-Error rejection', async () => {
      const transport = new FileTransport({ path: '/tmp/test.log' });

      vi.spyOn(fs, 'stat').mockImplementation((_path, callback) => {
        (callback as Function)({ code: 'ENOENT' });
      });
      vi.spyOn(fs, 'appendFile').mockImplementation((_path, _data, callback) => {
        (callback as Function)('string error');
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await expect(transport.send('data')).rejects.toBe('string error');
      expect(warnSpy).toHaveBeenCalledWith(
        '[ErrorCore] File transport dropped payload: string error'
      );
    });
  });

  describe('sendSync', () => {
    it('appends with flag "a"', () => {
      const transport = new FileTransport({ path: '/tmp/test.log' });

      const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);

      transport.sendSync('sync payload');

      expect(writeSpy).toHaveBeenCalledWith(
        '/tmp/test.log',
        'sync payload\n',
        { flag: 'a' }
      );
    });

    it('catches errors without rethrowing', () => {
      const transport = new FileTransport({ path: '/tmp/test.log' });

      vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
        throw new Error('read-only fs');
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      expect(() => transport.sendSync('data')).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(
        '[ErrorCore] File transport sync write failed: read-only fs'
      );
    });

    it('handles non-Error thrown values', () => {
      const transport = new FileTransport({ path: '/tmp/test.log' });

      vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
        throw 'raw string';
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      expect(() => transport.sendSync('data')).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(
        '[ErrorCore] File transport sync write failed: raw string'
      );
    });
  });

  describe('rotation', () => {
    it('does not rotate when the file does not exist', async () => {
      const transport = new FileTransport({ path: '/tmp/test.log' });

      vi.spyOn(fs, 'stat').mockImplementation((_path, callback) => {
        (callback as Function)(new Error('ENOENT'));
      });
      const renameSpy = vi.spyOn(fs, 'rename').mockImplementation((_o, _n, cb) => {
        (cb as Function)();
      });
      vi.spyOn(fs, 'appendFile').mockImplementation((_path, _data, callback) => {
        (callback as Function)();
      });

      await transport.send('test');

      expect(renameSpy).not.toHaveBeenCalled();
    });

    it('does not rotate when the file is smaller than maxSizeBytes', async () => {
      const transport = new FileTransport({ path: '/tmp/test.log', maxSizeBytes: 1024 });

      vi.spyOn(fs, 'stat').mockImplementation((_path, callback) => {
        (callback as Function)(null, { size: 512 });
      });
      const renameSpy = vi.spyOn(fs, 'rename').mockImplementation((_o, _n, cb) => {
        (cb as Function)();
      });
      vi.spyOn(fs, 'appendFile').mockImplementation((_path, _data, callback) => {
        (callback as Function)();
      });

      await transport.send('test');

      expect(renameSpy).not.toHaveBeenCalled();
    });

    it('does not rotate when the file is exactly maxSizeBytes', async () => {
      const transport = new FileTransport({ path: '/tmp/test.log', maxSizeBytes: 1024 });

      vi.spyOn(fs, 'stat').mockImplementation((_path, callback) => {
        (callback as Function)(null, { size: 1024 });
      });
      const renameSpy = vi.spyOn(fs, 'rename').mockImplementation((_o, _n, cb) => {
        (cb as Function)();
      });
      vi.spyOn(fs, 'appendFile').mockImplementation((_path, _data, callback) => {
        (callback as Function)();
      });

      await transport.send('test');

      expect(renameSpy).not.toHaveBeenCalled();
    });

    it('rotates the file when it exceeds maxSizeBytes', async () => {
      const transport = new FileTransport({ path: '/tmp/test.log', maxSizeBytes: 1024 });

      vi.spyOn(fs, 'stat').mockImplementation((_path, callback) => {
        (callback as Function)(null, { size: 2048 });
      });
      const now = 1700000000000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const renameSpy = vi.spyOn(fs, 'rename').mockImplementation((_o, _n, cb) => {
        (cb as Function)();
      });
      vi.spyOn(fs, 'readdir').mockImplementation((_dir, callback) => {
        (callback as Function)(null, []);
      });
      vi.spyOn(fs, 'appendFile').mockImplementation((_path, _data, callback) => {
        (callback as Function)();
      });

      await transport.send('test');

      expect(renameSpy).toHaveBeenCalledWith(
        '/tmp/test.log',
        `/tmp/test.log.${now}-1.bak`,
        expect.any(Function)
      );
    });

    it('produces distinct filenames when two rotations fire in the same millisecond', async () => {
      // Regression: previously the rotated filename was ${path}.${Date.now()}.bak
      // so two rotations inside the same ms tick collided and the second
      // rename overwrote the first. With a monotonic per-instance counter
      // the two renames use distinct names.
      const transport = new FileTransport({ path: '/tmp/test.log', maxSizeBytes: 1024 });

      vi.spyOn(fs, 'stat').mockImplementation((_path, callback) => {
        (callback as Function)(null, { size: 2048 });
      });
      vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
      const renameSpy = vi.spyOn(fs, 'rename').mockImplementation((_o, _n, cb) => {
        (cb as Function)();
      });
      vi.spyOn(fs, 'readdir').mockImplementation((_dir, callback) => {
        (callback as Function)(null, []);
      });
      vi.spyOn(fs, 'appendFile').mockImplementation((_path, _data, callback) => {
        (callback as Function)();
      });

      await Promise.all([transport.send('a'), transport.send('b')]);

      const calls = renameSpy.mock.calls.map((call) => call[1] as string);
      expect(new Set(calls).size).toBe(calls.length);
    });
  });

  describe('cleanup', () => {
    it('deletes oldest backups beyond maxBackups', async () => {
      const transport = new FileTransport({
        path: '/tmp/test.log',
        maxSizeBytes: 100,
        maxBackups: 2
      });

      vi.spyOn(fs, 'stat').mockImplementation((_path, callback) => {
        (callback as Function)(null, { size: 200 });
      });
      vi.spyOn(Date, 'now').mockReturnValue(9000);
      vi.spyOn(fs, 'rename').mockImplementation((_o, _n, cb) => {
        (cb as Function)();
      });
      vi.spyOn(fs, 'appendFile').mockImplementation((_path, _data, callback) => {
        (callback as Function)();
      });

      const backupFiles = [
        'test.log.1000.bak',
        'test.log.2000.bak',
        'test.log.3000.bak',
        'test.log.4000.bak',
        'test.log.5000.bak',
        'other-file.txt'
      ];
      vi.spyOn(fs, 'readdir').mockImplementation((_dir, callback) => {
        (callback as Function)(null, backupFiles);
      });
      const unlinkSpy = vi.spyOn(fs, 'unlink').mockImplementation((_path, callback) => {
        (callback as Function)();
      });

      await transport.send('test');

      // 5 backups found, sorted reverse: 5000,4000,3000,2000,1000
      // slice(2) gives: 3000, 2000, 1000 to be deleted
      expect(unlinkSpy).toHaveBeenCalledTimes(3);
      expect(unlinkSpy).toHaveBeenCalledWith(path.join('/tmp', 'test.log.3000.bak'), expect.any(Function));
      expect(unlinkSpy).toHaveBeenCalledWith(path.join('/tmp', 'test.log.2000.bak'), expect.any(Function));
      expect(unlinkSpy).toHaveBeenCalledWith(path.join('/tmp', 'test.log.1000.bak'), expect.any(Function));
    });

    it('does not delete anything when backups are within the limit', async () => {
      const transport = new FileTransport({
        path: '/tmp/test.log',
        maxSizeBytes: 100,
        maxBackups: 5
      });

      vi.spyOn(fs, 'stat').mockImplementation((_path, callback) => {
        (callback as Function)(null, { size: 200 });
      });
      vi.spyOn(Date, 'now').mockReturnValue(9000);
      vi.spyOn(fs, 'rename').mockImplementation((_o, _n, cb) => {
        (cb as Function)();
      });
      vi.spyOn(fs, 'appendFile').mockImplementation((_path, _data, callback) => {
        (callback as Function)();
      });
      vi.spyOn(fs, 'readdir').mockImplementation((_dir, callback) => {
        (callback as Function)(null, [
          'test.log.1000.bak',
          'test.log.2000.bak',
          'test.log.3000.bak'
        ]);
      });
      const unlinkSpy = vi.spyOn(fs, 'unlink').mockImplementation((_path, callback) => {
        (callback as Function)();
      });

      await transport.send('test');

      expect(unlinkSpy).not.toHaveBeenCalled();
    });

    it('ignores files that do not match the backup pattern', async () => {
      const transport = new FileTransport({
        path: '/tmp/test.log',
        maxSizeBytes: 100,
        maxBackups: 1
      });

      vi.spyOn(fs, 'stat').mockImplementation((_path, callback) => {
        (callback as Function)(null, { size: 200 });
      });
      vi.spyOn(Date, 'now').mockReturnValue(9000);
      vi.spyOn(fs, 'rename').mockImplementation((_o, _n, cb) => {
        (cb as Function)();
      });
      vi.spyOn(fs, 'appendFile').mockImplementation((_path, _data, callback) => {
        (callback as Function)();
      });
      vi.spyOn(fs, 'readdir').mockImplementation((_dir, callback) => {
        (callback as Function)(null, [
          'test.log.1000.bak',
          'test.log.2000.bak',
          'other.log.3000.bak',
          'test.log.txt',
          'readme.md'
        ]);
      });
      const unlinkSpy = vi.spyOn(fs, 'unlink').mockImplementation((_path, callback) => {
        (callback as Function)();
      });

      await transport.send('test');

      // Only test.log.*.bak matches; 2 found, maxBackups=1, so 1 deleted
      expect(unlinkSpy).toHaveBeenCalledTimes(1);
      expect(unlinkSpy).toHaveBeenCalledWith(path.join('/tmp', 'test.log.1000.bak'), expect.any(Function));
    });

    it('silently handles readdir errors during cleanup', async () => {
      const transport = new FileTransport({
        path: '/tmp/test.log',
        maxSizeBytes: 100,
        maxBackups: 2
      });

      vi.spyOn(fs, 'stat').mockImplementation((_path, callback) => {
        (callback as Function)(null, { size: 200 });
      });
      vi.spyOn(Date, 'now').mockReturnValue(9000);
      vi.spyOn(fs, 'rename').mockImplementation((_o, _n, cb) => {
        (cb as Function)();
      });
      vi.spyOn(fs, 'appendFile').mockImplementation((_path, _data, callback) => {
        (callback as Function)();
      });
      vi.spyOn(fs, 'readdir').mockImplementation((_dir, callback) => {
        (callback as Function)(new Error('permission denied'));
      });

      // Should not reject despite readdir error
      await expect(transport.send('test')).resolves.toBeUndefined();
    });
  });

  describe('flush', () => {
    it('resolves immediately', async () => {
      const transport = new FileTransport({ path: '/tmp/test.log' });
      await expect(transport.flush()).resolves.toBeUndefined();
    });
  });

  describe('shutdown', () => {
    it('resolves immediately', async () => {
      const transport = new FileTransport({ path: '/tmp/test.log' });
      await expect(transport.shutdown()).resolves.toBeUndefined();
    });
  });
});
