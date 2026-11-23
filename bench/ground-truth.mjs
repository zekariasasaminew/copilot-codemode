// Ground truth for the benchmark tasks, computed with `gh api` (independent of MCP and of
// either benchmark arm). Historical windows keep answers stable across runs.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = 'cloudflare/agents';
const gh = (args) => JSON.parse(execFileSync('gh', ['api', ...args], { encoding: 'utf8', maxBuffer: 256 * 2 ** 20 }));
const ghPaged = (url) => {
  const out = execFileSync('gh', ['api', '--paginate', '--slurp', url], { encoding: 'utf8', maxBuffer: 256 * 2 ** 20 });
  return JSON.parse(out).flat();
};
const search = (q) => {
  const items = [];
  for (let page = 1; page <= 10; page++) {
    const r = gh(['-X', 'GET', 'search/issues', '-f', `q=${q}`, '-f', 'per_page=100', '-f', `page=${page}`]);
    items.push(...r.items);
    if (items.length >= r.total_count || !r.items.length) return { total: r.total_count, items };
  }
  return { total: items.length, items };
};
// Area = first two path segments for paths with 3+ segments, else the first segment.
const area = (file) => {
  const parts = file.split('/');
  return parts.length >= 3 ? parts.slice(0, 2).join('/') : parts[0];
};
const rank = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

const WEEK_Q = `repo:${REPO} is:pr is:merged merged:2026-10-27..2026-10-31`;
const MONTH_Q = `repo:${REPO} is:pr is:merged merged:2026-10-01..2026-10-31`;

const week = search(WEEK_Q);
const numbers = week.items.map((i) => i.number).sort((a, b) => a - b);
console.log('week PRs', numbers.length);

const unapproved = [];
const approved = [];
let totalReviews = 0;
const areaCounts = {};
for (const n of numbers) {
  const reviews = ghPaged(`repos/${REPO}/pulls/${n}/reviews?per_page=100`);
  totalReviews += reviews.length;
  if (reviews.some((r) => r.state === 'APPROVED')) approved.push(n);
  else unapproved.push(n);
  const files = ghPaged(`repos/${REPO}/pulls/${n}/files?per_page=100`);
  for (const a of new Set(files.map((f) => area(f.filename)))) areaCounts[a] = (areaCounts[a] ?? 0) + 1;
}

const month = search(MONTH_Q);
const authorCounts = {};
for (const i of month.items) authorCounts[i.user.login] = (authorCounts[i.user.login] ?? 0) + 1;

const single = numbers[Math.floor(numbers.length / 2)];
const pr = gh([`repos/${REPO}/pulls/${single}`]);

const truth = {
  computedAt: new Date().toISOString(),
  single: { pr: single, author: pr.user.login, merged_at: pr.merged_at.slice(0, 10), changed_files: pr.changed_files },
  reviews: { query: WEEK_Q, prs: numbers, approved, totalReviews, unapproved },
  areas: { query: WEEK_Q, ranking: rank(areaCounts) },
  authors: { query: MONTH_Q, merged: month.total, itemsSeen: month.items.length, ranking: rank(authorCounts) },
};
writeFileSync(path.join(here, 'truth.json'), JSON.stringify(truth, null, 2));
console.log(JSON.stringify({ ...truth, areas: { ...truth.areas, ranking: truth.areas.ranking.slice(0, 8) }, authors: { ...truth.authors, ranking: truth.authors.ranking.slice(0, 8) } }, null, 1));
