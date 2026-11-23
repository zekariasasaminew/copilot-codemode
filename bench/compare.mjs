// Cross-model table: median credits and wall-clock per task for each arm, and pass rates.
// Usage: node bench/compare.mjs <results dir> [<results dir> ...]
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (a, b) => (a && b != null ? `${Math.round(((b - a) / a) * 100)}%` : '');
const TASKS = ['single', 'reviews', 'areas', 'authors'];

const lines = ['| Model | ' + TASKS.map((t) => `${t} credits`).join(' | ') + ' | fan-out time | pass classic | pass code mode | total credits |', `|---|${TASKS.map(() => '---').join('|')}|---|---|---|---|`];
for (const dir of process.argv.slice(2)) {
  const file = path.join(dir, 'runs.jsonl');
  if (!existsSync(file)) continue;
  const rows = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.invalid && !(r.shellNetwork > 0));
  const of = (task, arm, k) => median(rows.filter((r) => r.task === task && r.arm === arm).map(k));
  const cells = TASKS.map((t) => {
    const a = of(t, 'classic', (r) => r.credits);
    const b = of(t, 'codemode', (r) => r.credits);
    return a == null || b == null ? '' : `${a.toFixed(1)} → ${b.toFixed(1)} (${pct(a, b)})`;
  });
  const fan = (arm) => median(rows.filter((r) => r.arm === arm && r.task !== 'single').map((r) => r.wallMs / 1000));
  const pass = (arm) => {
    const rs = rows.filter((r) => r.arm === arm);
    return `${rs.filter((r) => r.pass).length}/${rs.length}`;
  };
  const total = rows.reduce((n, r) => n + (r.credits ?? 0), 0);
  lines.push(`| ${path.basename(dir)} | ${cells.join(' | ')} | ${Math.round(fan('classic'))}s → ${Math.round(fan('codemode'))}s | ${pass('classic')} | ${pass('codemode')} | ${total.toFixed(0)} |`);
}
console.log(lines.join('\n'));
