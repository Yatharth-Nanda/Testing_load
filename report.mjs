import { readdir, readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const directory = process.argv[2] || 'results';
const files = (await readdir(directory)).filter((name) => /^(burst|preflight)-shard-\d+\.json$/.test(name));
if (!files.length) throw new Error('No shard results found.');
const shards = await Promise.all(files.map(async (name) => JSON.parse(await readFile(path.join(directory, name), 'utf8'))));
const burst = shards.filter((shard) => shard.mode === 'burst');
const selected = burst.length ? burst : shards;
const rows = selected.flatMap((shard) => shard.results);
const starts = rows.map((row) => row.navigationStartedAt).filter(Number.isFinite);
const arrivalWindow = starts.length ? Math.max(...starts) - Math.min(...starts) : null;
const complete = rows.length === (burst.length ? 100 : 3) && new Set(rows.map((row) => row.id)).size === rows.length;
const pressure = selected.some((shard) => shard.host.eventLoopP95Ms > 100
  || shard.telemetry.some((sample) => sample.cpuPercent > 90 || sample.freeRamGB < 1));
function stats(field, subset = rows) {
  const values = subset.map((row) => row[field]).filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return 'n/a';
  const percentile = (p) => values[Math.max(0, Math.ceil(values.length * p) - 1)].toFixed(0);
  return `${percentile(0.5)} / ${percentile(0.95)} / ${values.at(-1).toFixed(0)} ms`;
}
const validBurst = !burst.length || (complete && starts.length === 100 && arrivalWindow <= 1000);
const passed = complete && validBurst && !pressure && rows.every((row) => row.successful && row.pageWithin5s && row.fillWithin2s);
const lines = [
  '# Waitlist browser test', '',
  `Result: **${passed ? 'PASS' : pressure || !validBurst || !complete ? 'INCONCLUSIVE' : 'FAIL'}**`, '',
  `Mode: ${burst.length ? '100-user burst, real submissions' : 'sequential preflight, no submissions'}.`,
  `Users recorded: ${rows.length}. Actual navigation arrival window: ${arrivalWindow ?? 'n/a'} ms.`,
  `Load-generator pressure detected: ${pressure ? 'yes; page slowness cannot be attributed solely to the site' : 'no warning detected'}.`, '',
  '| Flow | Completed | Page ready ≤5s | Filled ≤2s | Page ready p50 / p95 / max | Fill p50 / p95 / max | Click → success p50 / p95 / max |',
  '|---|---:|---:|---:|---|---|---|',
];
for (const variant of ['name-email', 'phone-auto-consent', 'phone-unchecked-consent']) {
  const group = rows.filter((row) => row.variant === variant);
  lines.push(`| ${variant} | ${group.filter((row) => row.successful).length}/${group.length} | ${group.filter((row) => row.pageWithin5s).length}/${group.length} | ${group.filter((row) => row.fillWithin2s).length}/${group.length} | ${stats('pageReadyMs', group)} | ${stats('fillMs', group)} | ${stats('clickToSuccessMs', group)} |`);
}
lines.push('', 'Page readiness includes a full-page scroll to trigger lazy images, loaded HTML image elements and fonts, and the form in view. It is a conservative full-page measurement, not just the browser load event.',
  'Typing uses real keyboard events, approximately 1.1 seconds of deliberate key delays, then waits until the two-second mark before submitting. The fill measurement includes automation overhead. Event Timing entries and long tasks are recorded in JSON; the maximum event duration is a responsiveness diagnostic, not a field INP score.',
  'Desktop Chromium, 1440×900, fresh contexts, no CPU/network throttling. GitHub runner location and clock differences limit comparison with real Indian mobile users. No warning detected does not prove the generator was never a bottleneck.', '', '## Errors', '');
for (const row of rows) if (row.errors.length || row.javascriptErrors.length || row.failedRequests.length) {
  lines.push(`- User ${row.id + 1}: ${JSON.stringify({ errors: row.errors, javascriptErrors: row.javascriptErrors, failedRequests: row.failedRequests })}`);
}
const report = lines.join('\n');
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'report.md'), report);
await writeFile(path.join(directory, 'cleanup-emails.txt'), rows.filter((row) => row.submitted).map((row) => row.email).join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report);
console.log(report);
if (!passed) process.exitCode = 1;
