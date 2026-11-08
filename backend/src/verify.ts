import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { CheckResult } from './types.ts';

type CheckStatus = CheckResult['status'];
export interface MathCheck { lhs: string; rhs: string }

const SCRIPT = fileURLToPath(new URL('../scripts/verify_math.py', import.meta.url));

export interface VerifyOutcome {
  results: CheckStatus[];
  verifier: 'sympy' | 'none';
}

// Runs the SymPy checker in an isolated Python process (-I) with a hard timeout.
// Any failure degrades to "unverified"; verification never blocks a result.
export async function verifyChecks(checks: MathCheck[], pythonBin: string, timeoutMs = 10_000): Promise<VerifyOutcome> {
  const none: VerifyOutcome = { results: checks.map(() => 'unverified'), verifier: 'none' };
  if (checks.length === 0) return { results: [], verifier: 'none' };
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v: VerifyOutcome) => { if (!done) { done = true; resolve(v); } };
    const child = spawn(pythonBin, ['-I', SCRIPT], { stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(none); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); finish(none); });
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out) as { results: CheckStatus[]; sympy: boolean };
        if (parsed.results.length !== checks.length) return finish(none);
        finish({ results: parsed.results, verifier: parsed.sympy ? 'sympy' : 'none' });
      } catch {
        finish(none);
      }
    });
    child.stdin.end(JSON.stringify({ checks }));
  });
}
