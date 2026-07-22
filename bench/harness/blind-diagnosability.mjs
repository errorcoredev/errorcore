import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export function writeBlindDiagnosabilityPrompts({
  resultsDir,
  scenarioResults,
  filename = 'blind-diagnosability-prompts.jsonl'
}) {
  const out = path.join(resultsDir, filename);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const lines = [];
  for (const result of scenarioResults) {
    for (const variant of result.variants) {
      lines.push(JSON.stringify({
        scenarioId: result.scenarioId,
        sdk: variant.sdk,
        instruction: 'Diagnose the root cause using only this captured payload JSON. Do not assume source code access.',
        payloads: variant.payloads
      }));
    }
  }
  fs.writeFileSync(out, lines.join('\n') + (lines.length > 0 ? '\n' : ''));
  return out;
}

function parseJudgeStdout(stdout) {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const parsed = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      return {
        parsed: [],
        rawOutput: stdout
      };
    }
  }
  return { parsed, rawOutput: undefined };
}

function summarizeAgreement(results) {
  const summary = {
    rootCauseAgreement: { agreed: 0, total: 0 },
    frameAgreement: { agreed: 0, total: 0 }
  };
  for (const result of results) {
    if (typeof result.rootCauseAgreement === 'boolean') {
      summary.rootCauseAgreement.total += 1;
      if (result.rootCauseAgreement) summary.rootCauseAgreement.agreed += 1;
    }
    if (typeof result.frameAgreement === 'boolean') {
      summary.frameAgreement.total += 1;
      if (result.frameAgreement) summary.frameAgreement.agreed += 1;
    }
  }
  return summary;
}

export async function runBlindJudge({ promptsPath, command = process.env.BENCH_BLIND_JUDGE_COMMAND } = {}) {
  if (command === undefined || command.trim().length === 0) {
    return {
      status: 'not-run',
      reason: 'BENCH_BLIND_JUDGE_COMMAND is not configured',
      results: []
    };
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      windowsHide: true,
      timeout: Number(process.env.BENCH_BLIND_JUDGE_TIMEOUT_MS ?? 120_000),
      env: {
        ...process.env,
        BENCH_BLIND_PROMPTS: promptsPath
      }
    });
    const parsed = parseJudgeStdout(stdout);
    const results = parsed.parsed;
    return {
      status: 'completed',
      command,
      results,
      agreement: summarizeAgreement(results),
      rawOutput: parsed.rawOutput,
      stderr: stderr.trim()
    };
  } catch (error) {
    return {
      status: 'failed',
      command,
      reason: error instanceof Error ? error.message : String(error),
      results: []
    };
  }
}
