
const isTTY = process.stdout.isTTY === true;

type StyleFn = (text: string) => string;

function ansi(open: string, close: string): StyleFn {
  if (!isTTY) return (text: string) => text;
  return (text: string) => `\x1b[${open}m${text}\x1b[${close}m`;
}

function compose(...fns: StyleFn[]): StyleFn {
  return (text: string) => fns.reduceRight((acc, fn) => fn(acc), text);
}

const bold = ansi('1', '22');
const dim = ansi('2', '22');
const italic = ansi('3', '23');

const red = ansi('31', '39');
const green = ansi('32', '39');
const yellow = ansi('33', '39');
const magenta = ansi('35', '39');
const cyan = ansi('36', '39');
const white = ansi('37', '39');
const gray = ansi('90', '39');
const redBright = ansi('91', '39');
const yellowBright = ansi('93', '39');

export const theme = {
  errorType: compose(bold, redBright),
  errorMessage: red,

  timestamp: gray,
  dim: dim,
  sectionLabel: compose(dim, gray),

  filePath: yellow,
  lineNumber: yellow,
  functionName: yellowBright,

  methodGet: green,
  methodPost: magenta,
  methodPut: yellow,
  methodDelete: red,
  methodPatch: cyan,
  methodDefault: gray,

  status2xx: green,
  status3xx: yellow,
  status4xx: red,
  status5xx: redBright,

  label: gray,
  value: white,

  appFrame: white,
  vendorFrame: dim,
  collapsedFrames: compose(dim, italic),

  durationNormal: gray,
  durationSlow: yellow,
  durationVerySlow: red,

  localKey: cyan,
  localValue: white,
  localNull: dim,
  localString: green,
  localNumber: yellowBright,
  localBoolean: magenta,

  ioType: compose(dim, cyan),
} as const;

export function colorForMethod(method: string): StyleFn {
  switch (method.toUpperCase()) {
    case 'GET': return theme.methodGet;
    case 'POST': return theme.methodPost;
    case 'PUT': return theme.methodPut;
    case 'DELETE': return theme.methodDelete;
    case 'PATCH': return theme.methodPatch;
    default: return theme.methodDefault;
  }
}

export function colorForStatus(status: number): StyleFn {
  if (status >= 500) return theme.status5xx;
  if (status >= 400) return theme.status4xx;
  if (status >= 300) return theme.status3xx;
  if (status >= 200) return theme.status2xx;
  return theme.dim;
}

export function colorForDuration(ms: number): StyleFn {
  if (ms >= 5000) return theme.durationVerySlow;
  if (ms >= 1000) return theme.durationSlow;
  return theme.durationNormal;
}
