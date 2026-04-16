
const debugEnabled =
  typeof process !== 'undefined' && process.env?.ERRORCORE_DEBUG === '1';

export function createDebug(component: string): (message: string) => void {
  const prefix = `[ErrorCore:${component}]`;

  return (message: string): void => {
    if (debugEnabled) {
      console.debug(`${prefix} ${message}`);
    }
  };
}
