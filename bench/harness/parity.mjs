function normalizePath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return 'unknown';
  }
  const normalized = filePath.replace(/\\/g, '/');
  const benchIndex = normalized.indexOf('bench/apps/benchmark-app/');
  if (benchIndex >= 0) {
    return normalized.slice(benchIndex);
  }
  const appIndex = normalized.indexOf('/app/');
  if (appIndex >= 0) {
    return normalized.slice(appIndex + 5);
  }
  return normalized.replace(/^[A-Za-z]:/, '').replace(/^\/+/, '');
}

function normalizeMessage(message) {
  return String(message ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function frameLabel(frame) {
  if (frame === null || frame === undefined) {
    return 'unknown@unknown';
  }
  const fn = frame.functionName ?? frame.function ?? frame.method ?? '<anonymous>';
  const file = frame.filePath ?? frame.filename ?? frame.abs_path ?? frame.file ?? 'unknown';
  return `${fn}@${normalizePath(file)}`;
}

function parseFirstAppFrameFromStack(stack) {
  if (typeof stack !== 'string') {
    return null;
  }
  for (const line of stack.split('\n')) {
    if (!line.includes('bench/apps/benchmark-app')) {
      continue;
    }
    const match = line.match(/at\s+(.*?)\s+\((.*?):\d+:\d+\)/) ?? line.match(/at\s+(.*?):\d+:\d+/);
    if (match === null) {
      continue;
    }
    if (match.length === 3) {
      return { functionName: match[1], filePath: match[2] };
    }
    return { functionName: '<anonymous>', filePath: match[1] };
  }
  return null;
}

function extractErrorcoreSignal(payload) {
  const boundary = payload?.errorOrigin?.appBoundaryFrame ?? parseFirstAppFrameFromStack(payload?.error?.stack);
  return {
    type: payload?.error?.type ?? 'Error',
    message: normalizeMessage(payload?.error?.message),
    topAppFrame: frameLabel(boundary)
  };
}

function extractSentrySignal(payload) {
  const exception = payload?.exception?.values?.[0] ?? {};
  const frames = exception?.stacktrace?.frames ?? [];
  const frame =
    frames.find((candidate) => candidate.in_app === true) ??
    frames.find((candidate) => typeof candidate.filename === 'string' && candidate.filename.includes('bench/apps/benchmark-app')) ??
    frames.at(-1);
  return {
    type: exception.type ?? 'Error',
    message: normalizeMessage(exception.value ?? payload?.message),
    topAppFrame: frameLabel(frame)
  };
}

function extractBugsnagSignal(payload) {
  const exception = payload?.exceptions?.[0] ?? payload?.events?.[0]?.exceptions?.[0] ?? {};
  const frames = exception.stacktrace ?? [];
  const frame =
    frames.find((candidate) => typeof candidate.file === 'string' && candidate.file.includes('bench/apps/benchmark-app')) ??
    frames.at(0);
  return {
    type: exception.errorClass ?? exception.type ?? 'Error',
    message: normalizeMessage(exception.message ?? payload?.message),
    topAppFrame: frameLabel(frame)
  };
}

export function extractSignal(sdk, payload) {
  if (sdk === 'errorcore') {
    return extractErrorcoreSignal(payload);
  }
  if (sdk === 'sentry') {
    return extractSentrySignal(payload);
  }
  if (sdk === 'bugsnag') {
    return extractBugsnagSignal(payload);
  }
  throw new Error(`Unknown SDK for parity extraction: ${sdk}`);
}

function winnerForMatch(left, right, leftMatches, rightMatches) {
  if (leftMatches === rightMatches) return 'tie';
  return leftMatches ? left.sdk : right.sdk;
}

function expectedFrameMatches(signal, expected) {
  const expectedFrame = expected?.expectedOriginatingFrame;
  if (typeof expectedFrame !== 'string' || expectedFrame.length === 0) {
    return false;
  }
  return String(signal.topAppFrame ?? '').startsWith(`${expectedFrame}@`);
}

function expectedMessageMatches(signal, expected) {
  return normalizeMessage(signal.message) === normalizeMessage(expected?.expectedMessage);
}

function compareCloserToGroundTruth(left, right, leftSignal, rightSignal, expected) {
  const leftMessageMatches = expectedMessageMatches(leftSignal, expected);
  const rightMessageMatches = expectedMessageMatches(rightSignal, expected);
  const leftFrameMatches = expectedFrameMatches(leftSignal, expected);
  const rightFrameMatches = expectedFrameMatches(rightSignal, expected);
  const messageWinner = winnerForMatch(left, right, leftMessageMatches, rightMessageMatches);
  const frameWinner = winnerForMatch(left, right, leftFrameMatches, rightFrameMatches);
  const evidence = [];

  if (messageWinner === 'tie') {
    evidence.push(leftMessageMatches
      ? 'both SDK messages matched expected'
      : 'neither SDK message matched expected');
  } else {
    evidence.push(`${messageWinner} message matched expected; ${messageWinner === left.sdk ? right.sdk : left.sdk} message did not`);
  }

  if (frameWinner === 'tie') {
    evidence.push(leftFrameMatches
      ? 'both SDK frames matched expected'
      : 'neither SDK frame matched expected');
  } else {
    evidence.push(`${frameWinner} frame matched expected; ${frameWinner === left.sdk ? right.sdk : left.sdk} frame did not`);
  }

  return {
    messageWinner,
    frameWinner,
    evidence
  };
}

function summarizeTriggerLogs(logs = []) {
  return logs.map((entry) => `${entry.scenarioId ?? entry.scenario ?? ''}:${entry.event ?? ''}`);
}

function summarizeDependencyLogs(logs = []) {
  return logs.map((entry) => `${entry.scenarioId ?? entry.scenario ?? ''}:${entry.dependency ?? ''}:${entry.fault ?? entry.event ?? ''}`);
}

export function compareParity(left, right, options = {}) {
  const failures = [];
  if (left?.http?.status !== right?.http?.status) {
    failures.push(`HTTP status differs: ${left?.http?.status} vs ${right?.http?.status}`);
  }

  const leftSignal = extractSignal(left.sdk, left.payloads?.[0] ?? {});
  const rightSignal = extractSignal(right.sdk, right.payloads?.[0] ?? {});

  for (const key of ['type', 'message', 'topAppFrame']) {
    if (leftSignal[key] !== rightSignal[key]) {
      failures.push(`${key} differs: ${leftSignal[key]} vs ${rightSignal[key]}`);
    }
  }

  const leftTriggers = summarizeTriggerLogs(left.triggerLogs);
  const rightTriggers = summarizeTriggerLogs(right.triggerLogs);
  if (JSON.stringify(leftTriggers) !== JSON.stringify(rightTriggers)) {
    failures.push(`trigger logs differ: ${JSON.stringify(leftTriggers)} vs ${JSON.stringify(rightTriggers)}`);
  }

  const leftDeps = summarizeDependencyLogs(left.dependencyLogs);
  const rightDeps = summarizeDependencyLogs(right.dependencyLogs);
  if (JSON.stringify(leftDeps) !== JSON.stringify(rightDeps)) {
    failures.push(`dependency fault logs differ: ${JSON.stringify(leftDeps)} vs ${JSON.stringify(rightDeps)}`);
  }

  return {
    ok: failures.length === 0,
    failures,
    leftSignal,
    rightSignal,
    closerToGroundTruth: options.expected === undefined
      ? undefined
      : compareCloserToGroundTruth(left, right, leftSignal, rightSignal, options.expected)
  };
}
