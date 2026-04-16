
function isDebugEnabled(): boolean {
  // Read on every call so an operator can toggle ERRORCORE_DEBUG at
  // runtime (for example, during incident triage) without restarting
  // the host process. The previous module-level capture meant changes
  // to the env var were invisible until reimport.
  return typeof process !== 'undefined' && process.env?.ERRORCORE_DEBUG === '1';
}

export function createDebug(component: string): (message: string) => void {
  const prefix = `[ErrorCore:${component}]`;

  return (message: string): void => {
    if (isDebugEnabled()) {
      console.debug(`${prefix} ${message}`);
    }
  };
}
