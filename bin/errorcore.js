#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const distDir = path.join(__dirname, '..', 'dist');
const templatePath = path.join(__dirname, '..', 'config-template', 'errorcore.config.js');

const isTTY = process.stdout.isTTY === true;

function ansi(code, text) {
  return isTTY ? `\x1b[${code}m${text}\x1b[0m` : text;
}

const bold  = (t) => ansi('1', t);
const dim   = (t) => ansi('2', t);
const red   = (t) => ansi('31', t);
const green = (t) => ansi('32', t);
const yellow = (t) => ansi('33', t);
const cyan  = (t) => ansi('36', t);

function die(message) {
  process.stderr.write(red('Error: ') + message + '\n');
  process.exit(1);
}

function requireDist(modulePath) {
  const full = path.join(distDir, modulePath);
  try {
    return require(full);
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
      die('Run npm run build first');
    }
    throw err;
  }
}

function loadConfigFile(configPath) {
  const abs = path.resolve(configPath);
  try {
    return require(abs);
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
      die(`Config file not found: ${abs}`);
    }
    throw err;
  }
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config' && i + 1 < argv.length) {
      flags.config = argv[++i];
    } else if (arg === '--dry-run') {
      flags.dryRun = true;
    } else if (arg === '--force') {
      flags.force = true;
    } else if (!arg.startsWith('--')) {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function formatValue(val) {
  if (val === undefined) return dim('not set');
  if (val === null) return dim('null');
  if (typeof val === 'function') return dim('(custom function)');
  if (val instanceof RegExp) return val.toString();
  if (Array.isArray(val)) {
    if (val.length === 0) return '[]';
    if (val.every((v) => typeof v === 'string')) {
      if (val.length <= 4) return val.join(', ');
      return `[${val.length} items]`;
    }
    if (val.every((v) => v instanceof RegExp)) {
      return val.map((v) => v.toString()).join(', ');
    }
    return `[${val.length} items]`;
  }
  if (typeof val === 'object') {
    try { return JSON.stringify(val); } catch { return String(val); }
  }
  return String(val);
}

function cmdHelp() {
  const text = `
${bold('errorcore')} — ErrorCore command-line tool

${bold('Usage:')}
  errorcore <command> [options]

${bold('Commands:')}
  ${cyan('init')}                          Create errorcore.config.js in the current directory
  ${cyan('validate')} [--config <path>]    Validate config and print resolved values
  ${cyan('status')}   [--config <path>]    Show dead-letter store status
  ${cyan('drain')}    [--config <path>]    Re-send dead-letter payloads
             [--dry-run] [--force]
  ${cyan('help')}                          Show this help message

${bold('Examples:')}
  errorcore init
  errorcore validate
  errorcore validate --config ./my-errorcore.config.js
  errorcore status
  errorcore drain --dry-run
  errorcore drain --force
  errorcore drain
`.trimStart();

  process.stdout.write(text);
}

function cmdInit() {
  const dest = path.join(process.cwd(), 'errorcore.config.js');
  if (fs.existsSync(dest)) {
    die('errorcore.config.js already exists in the current directory');
  }

  if (!fs.existsSync(templatePath)) {
    die(
      'Config template not found at ' + templatePath + '.\n' +
      'This usually means the package was not installed correctly.\n' +
      'Try: npm install errorcore'
    );
  }

  fs.copyFileSync(templatePath, dest);
  process.stdout.write(green('Created errorcore.config.js') + '\n\n');
  process.stdout.write(bold('Next steps:') + '\n');
  process.stdout.write('  1. Edit errorcore.config.js to match your environment\n');
  process.stdout.write('  2. Add to your application entry point:\n\n');
  process.stdout.write(`     ${cyan("const errorcore = require('errorcore');")}\n`);
  process.stdout.write(`     ${cyan("errorcore.init(require('./errorcore.config.js'));")}\n\n`);
  process.stdout.write('  3. Run ' + cyan('errorcore validate') + ' to check your config\n');
}

function cmdValidate(flags) {
  const configPath = flags.config || path.join(process.cwd(), 'errorcore.config.js');
  const userConfig = loadConfigFile(configPath);
  const { resolveConfig } = requireDist('config.js');

  let resolved;
  try {
    resolved = resolveConfig(userConfig);
  } catch (err) {
    die(err.message || String(err));
  }

  if (resolved.allowUnencrypted === true && resolved.encryptionKey === undefined) {
    process.stdout.write(
      yellow('WARNING: ') +
      'allowUnencrypted is true and no encryptionKey is set \u2014 packages are stored in plaintext. ' +
      'Set encryptionKey before deploying to production.\n'
    );
  }

  process.stdout.write(green('Config is valid.') + '\n\n');

  const captureFlags = new Set([
    'captureLocalVariables',
    'captureBody',
    'captureDbBindParams',
  ]);

  const keys = Object.keys(resolved);
  const maxKeyLen = Math.max(...keys.map((k) => k.length));

  for (const key of keys) {
    const val = resolved[key];
    const label = key.padEnd(maxKeyLen + 2);

    if (captureFlags.has(key)) {
      const flag = val ? green(bold('ON')) : dim('OFF');
      process.stdout.write(`  ${label}${flag}\n`);
    } else {
      process.stdout.write(`  ${label}${formatValue(val)}\n`);
    }
  }

  process.stdout.write('\n');
}

function cmdStatus(flags) {
  const configPath = flags.config || path.join(process.cwd(), 'errorcore.config.js');
  let deadLetterPath;

  try {
    const userConfig = loadConfigFile(configPath);
    const { resolveConfig } = requireDist('config.js');
    const resolved = resolveConfig(userConfig);
    deadLetterPath = resolved.deadLetterPath;
  } catch {
    deadLetterPath = undefined;
  }

  if (!deadLetterPath) {
    process.stdout.write(yellow('No dead-letter store configured.') + '\n\n');
    process.stdout.write(
      'The dead-letter store is an NDJSON file where error packages are saved\n' +
      'when transport delivery fails. It is created automatically for file and\n' +
      'HTTP transports, or you can set deadLetterPath explicitly in your config.\n'
    );
    return;
  }

  process.stdout.write(bold('Dead-letter store: ') + deadLetterPath + '\n');

  if (!fs.existsSync(deadLetterPath)) {
    process.stdout.write(green('  File does not exist — no pending payloads.') + '\n');
    return;
  }

  const stat = fs.statSync(deadLetterPath);
  const sizeKB = (stat.size / 1024).toFixed(1);
  const content = fs.readFileSync(deadLetterPath, 'utf8');
  const lines = content.split('\n').filter((l) => l.length > 0);

  const timestamps = [];
  for (const line of lines) {
    try {
      const payload = JSON.parse(line);
      const inner = typeof payload === 'string' ? JSON.parse(payload) : payload;
      const ts = inner.capturedAt || inner.timestamp;
      if (ts) timestamps.push(new Date(ts));
    } catch { }
  }

  timestamps.sort((a, b) => a.getTime() - b.getTime());

  process.stdout.write(`  Size:     ${sizeKB} KB\n`);
  process.stdout.write(`  Payloads: ${lines.length}\n`);

  if (timestamps.length > 0) {
    process.stdout.write(`  Oldest:   ${timestamps[0].toISOString()}\n`);
    process.stdout.write(`  Newest:   ${timestamps[timestamps.length - 1].toISOString()}\n`);
  }
}

async function cmdDrain(flags) {
  const configPath = flags.config || path.join(process.cwd(), 'errorcore.config.js');
  const userConfig = loadConfigFile(configPath);
  const { resolveConfig } = requireDist('config.js');

  let resolved;
  try {
    resolved = resolveConfig(userConfig);
  } catch (err) {
    die(err.message || String(err));
  }

  const deadLetterPath = resolved.deadLetterPath;
  if (!deadLetterPath) {
    die('No dead-letter store configured.');
  }

  if (!fs.existsSync(deadLetterPath)) {
    process.stdout.write(green('Dead-letter store is empty — nothing to drain.') + '\n');
    return;
  }

  const transportAuthorization =
    userConfig.transport?.type === 'http' ? userConfig.transport.authorization : undefined;
  const integrityKey = resolved.encryptionKey ?? transportAuthorization ?? null;

  if (integrityKey === null) {
    die('Cannot drain: no encryptionKey or transport authorization configured (needed for HMAC verification).');
  }

  const { DeadLetterStore } = requireDist(path.join('transport', 'dead-letter-store.js'));
  const store = new DeadLetterStore(deadLetterPath, { integrityKey });
  const { entries, lineCount: snapshotLineCount } = store.drain();

  const payloads = entries.map((e) => e.payload);
  const payloadLineIndices = entries.map((e) => e.lineNumber - 1);

  if (payloads.length === 0) {
    process.stdout.write(green('No valid payloads in dead-letter store.') + '\n');
    return;
  }

  if (flags.dryRun) {
    process.stdout.write(bold(`${payloads.length} payload(s) pending`) + '\n\n');
    process.stdout.write(bold('First payload:') + '\n');
    try {
      const pretty = JSON.stringify(JSON.parse(payloads[0]), null, 2);
      process.stdout.write(pretty + '\n');
    } catch {
      process.stdout.write(payloads[0] + '\n');
    }
    return;
  }

  const transportType = resolved.transport.type;
  process.stdout.write(`Draining ${payloads.length} payload(s) via ${transportType} transport...\n`);

  if (transportType === 'stdout') {
    process.stdout.write(
      yellow('WARNING: ') +
      'Transport is stdout \u2014 payloads will be printed to terminal, not re-delivered to a collector. ' +
      'Switch to file or http transport to re-send to your collector.\n'
    );
  }

  if (!flags.force) {
    const readline = require('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => {
      rl.question('Proceed? [y/N] ', resolve);
    });
    rl.close();
    if (answer.toLowerCase() !== 'y') {
      process.exit(0);
    }
  }

  const transport = createTransportFromConfig(resolved, transportAuthorization);

  const failedLineIndices = new Set();
  let failures = 0;
  for (let i = 0; i < payloads.length; i++) {
    const label = `[${i + 1}/${payloads.length}]`;
    try {
      await transport.send(payloads[i]);
      process.stdout.write(`  ${label} ${green('sent')}\n`);
    } catch (err) {
      failures++;
      failedLineIndices.add(payloadLineIndices[i]);
      process.stdout.write(`  ${label} ${red('FAILED')} ${err.message || err}\n`);
    }
  }

  if (failures === 0) {
    const currentContent = fs.readFileSync(deadLetterPath, 'utf8');
    const currentLines = currentContent.split('\n').filter((l) => l.length > 0);
    if (currentLines.length <= snapshotLineCount) {
      fs.unlinkSync(deadLetterPath);
    } else {
      const remaining = currentLines.slice(snapshotLineCount).join('\n') + '\n';
      fs.writeFileSync(deadLetterPath, remaining, { encoding: 'utf8', mode: 0o600 });
    }
    process.stdout.write('\n' + green(`All ${payloads.length} payload(s) sent. Dead-letter store cleared.`) + '\n');
  } else {
    const currentContent = fs.readFileSync(deadLetterPath, 'utf8');
    const currentLines = currentContent.split('\n').filter((l) => l.length > 0);
    const kept = [];
    for (let i = 0; i < snapshotLineCount && i < currentLines.length; i++) {
      if (failedLineIndices.has(i)) {
        kept.push(currentLines[i]);
      }
    }
    for (let i = snapshotLineCount; i < currentLines.length; i++) {
      kept.push(currentLines[i]);
    }
    if (kept.length === 0) {
      if (fs.existsSync(deadLetterPath)) fs.unlinkSync(deadLetterPath);
    } else {
      fs.writeFileSync(deadLetterPath, kept.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
    }
    process.stdout.write('\n' + red(`${failures} payload(s) failed. Sent payloads removed from store; failed entries retained.`) + '\n');
    process.exit(1);
  }

  await transport.shutdown();
}

function createTransportFromConfig(config, authorization) {
  const t = config.transport;

  if (t.type === 'stdout') {
    const { StdoutTransport } = requireDist(path.join('transport', 'stdout-transport.js'));
    return new StdoutTransport();
  }

  if (t.type === 'file') {
    const { FileTransport } = requireDist(path.join('transport', 'file-transport.js'));
    return new FileTransport(t);
  }

  if (t.type === 'http') {
    const { HttpTransport } = requireDist(path.join('transport', 'http-transport.js'));
    return new HttpTransport({
      url: t.url,
      authorization: authorization,
      timeoutMs: t.timeoutMs,
      allowPlainHttpTransport: config.allowPlainHttpTransport,
    });
  }

  die(`Unsupported transport type: ${t.type}`);
}

const { flags, positional } = parseArgs(process.argv.slice(2));
const command = positional[0] || 'help';

switch (command) {
  case 'help':
  case '--help':
  case '-h':
    cmdHelp();
    break;

  case 'init':
    cmdInit();
    break;

  case 'validate':
    cmdValidate(flags);
    break;

  case 'status':
    cmdStatus(flags);
    break;

  case 'drain':
    cmdDrain(flags).catch((err) => {
      die(err.message || String(err));
    });
    break;

  default:
    process.stderr.write(red(`Unknown command: ${command}`) + '\n\n');
    cmdHelp();
    process.exit(1);
}
