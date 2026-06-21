import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetLogLevel,
  levelAllows,
  safeConsole,
  setLogLevel,
} from '../../src/debug-log';

describe('logLevel filter', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;
  let info: ReturnType<typeof vi.spyOn>;
  let debug: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetLogLevel();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetLogLevel();
  });

  it("defaults to 'warn' when never set", () => {
    expect(levelAllows('warn')).toBe(true);
    expect(levelAllows('error')).toBe(true);
    expect(levelAllows('info')).toBe(false);
    expect(levelAllows('debug')).toBe(false);
  });

  it("'silent' suppresses every level", () => {
    setLogLevel('silent');
    safeConsole.warn('hidden');
    safeConsole.error('hidden');
    safeConsole.info('hidden');
    safeConsole.debug('hidden');
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
  });

  it("'warn' allows error and warn but not info/debug", () => {
    setLogLevel('warn');
    safeConsole.warn('shown');
    safeConsole.info('hidden');
    expect(warn).toHaveBeenCalledOnce();
    expect(info).not.toHaveBeenCalled();
  });

  it("'debug' allows everything", () => {
    setLogLevel('debug');
    safeConsole.warn('w');
    safeConsole.info('i');
    safeConsole.debug('d');
    expect(warn).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledOnce();
    expect(debug).toHaveBeenCalledOnce();
  });

  it("'error' suppresses warn", () => {
    setLogLevel('error');
    safeConsole.warn('hidden');
    safeConsole.error('shown');
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
  });
});

import { resolveConfig } from '../../src/config';

describe('logLevel applied via resolveConfig + setLogLevel', () => {
  it('silent suppresses an ErrorCore warning emitted via safeConsole', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const resolved = resolveConfig({
        transport: { type: 'stdout' },
        allowUnencrypted: true,
        logLevel: 'silent',
      });
      setLogLevel(resolved.logLevel);
      safeConsole.warn('[ErrorCore] hidden');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      __resetLogLevel();
    }
  });

  it("'warn' emits warnings but suppresses info/debug", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const resolved = resolveConfig({
        transport: { type: 'stdout' },
        allowUnencrypted: true,
        logLevel: 'warn',
      });
      setLogLevel(resolved.logLevel);
      safeConsole.warn('[ErrorCore] visible');
      safeConsole.log('[ErrorCore] startup-line');
      expect(warn).toHaveBeenCalledOnce();
      expect(log).not.toHaveBeenCalled();  // log is treated as 'info'
    } finally {
      warn.mockRestore();
      log.mockRestore();
      __resetLogLevel();
    }
  });
});
