import type { LogLevel } from './types';

const LEVEL_RANK: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

let currentLevel: LogLevel = 'warn';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/** Test-only reset. */
export function __resetLogLevel(): void {
  currentLevel = 'warn';
}

export function levelAllows(level: Exclude<LogLevel, 'silent'>): boolean {
  return LEVEL_RANK[level] <= LEVEL_RANK[currentLevel];
}

export const safeConsole = {
  error(...args: unknown[]): void {
    if (levelAllows('error')) console.error(...args);
  },
  warn(...args: unknown[]): void {
    if (levelAllows('warn')) console.warn(...args);
  },
  info(...args: unknown[]): void {
    if (levelAllows('info')) console.info(...args);
  },
  log(...args: unknown[]): void {
    // Treated as 'info' so the startup diagnostic line (currently
    // console.log) can be silenced by setting logLevel: 'warn'.
    if (levelAllows('info')) console.log(...args);
  },
  debug(...args: unknown[]): void {
    if (levelAllows('debug')) console.debug(...args);
  },
};
