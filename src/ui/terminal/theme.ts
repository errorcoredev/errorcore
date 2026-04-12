
import chalk from 'chalk';

export const theme = {
  errorType: chalk.bold.redBright,
  errorMessage: chalk.red,

  timestamp: chalk.gray,
  dim: chalk.dim,
  sectionLabel: chalk.dim.gray,

  filePath: chalk.yellow,
  lineNumber: chalk.yellow,
  functionName: chalk.yellowBright,

  methodGet: chalk.green,
  methodPost: chalk.magenta,
  methodPut: chalk.yellow,
  methodDelete: chalk.red,
  methodPatch: chalk.cyan,
  methodDefault: chalk.gray,

  status2xx: chalk.green,
  status3xx: chalk.yellow,
  status4xx: chalk.red,
  status5xx: chalk.redBright,

  label: chalk.gray,
  value: chalk.white,

  appFrame: chalk.white,
  vendorFrame: chalk.dim,
  collapsedFrames: chalk.dim.italic,

  durationNormal: chalk.gray,
  durationSlow: chalk.yellow,
  durationVerySlow: chalk.red,

  localKey: chalk.cyan,
  localValue: chalk.white,
  localNull: chalk.dim,
  localString: chalk.green,
  localNumber: chalk.yellowBright,
  localBoolean: chalk.magenta,

  ioType: chalk.dim.cyan,
} as const;

export function colorForMethod(method: string): chalk.Chalk {
  switch (method.toUpperCase()) {
    case 'GET': return theme.methodGet;
    case 'POST': return theme.methodPost;
    case 'PUT': return theme.methodPut;
    case 'DELETE': return theme.methodDelete;
    case 'PATCH': return theme.methodPatch;
    default: return theme.methodDefault;
  }
}

export function colorForStatus(status: number): chalk.Chalk {
  if (status >= 500) return theme.status5xx;
  if (status >= 400) return theme.status4xx;
  if (status >= 300) return theme.status3xx;
  if (status >= 200) return theme.status2xx;
  return theme.dim;
}

export function colorForDuration(ms: number): chalk.Chalk {
  if (ms >= 5000) return theme.durationVerySlow;
  if (ms >= 1000) return theme.durationSlow;
  return theme.durationNormal;
}
