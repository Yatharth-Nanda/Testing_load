import { chromium } from 'playwright';
import os from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const mode = process.argv[2] || 'preflight';
if (!['preflight', 'burst'].includes(mode)) throw new Error('Use preflight or burst.');
const target = new URL(process.env.BASE_URL || 'https://www.fromthetop.in/');
const users = 50;
const shardCount = Number(process.env.SHARD_COUNT || 1);
const shardIndex = Number(process.env.SHARD_INDEX || 0);
const emailStart = Number(process.env.EMAIL_START || 1);
if (!Number.isInteger(shardCount) || shardCount < 1 || shardCount > 100
    || !Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount
    || !Number.isInteger(emailStart) || emailStart < 1) throw new Error('Invalid shard or email numbering.');
const ids = mode === 'preflight' ? [0, 1, 2]
  : Array.from({ length: users }, (_, id) => id).filter((id) => id % shardCount === shardIndex);
const emailStem = process.env.EMAIL_STEM || 'waitlist-load';
const emailDomain = process.env.EMAIL_DOMAIN || 'example.com';
const phone = process.env.TEST_PHONE || '1234567890';
if ((mode === 'burst' || process.env.GITHUB_ACTIONS === 'true')
    && (!process.env.EMAIL_STEM || !process.env.EMAIL_DOMAIN || !/^\d{10}$/.test(process.env.TEST_PHONE || ''))) {
  throw new Error('Cloud tests and bursts require EMAIL_STEM, EMAIL_DOMAIN, and a 10-digit TEST_PHONE.');
}
if (!/^[a-z0-9-]+$/i.test(emailStem) || !/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/i.test(emailDomain)) {
  throw new Error('Invalid test email stem or domain.');
}
const runId = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
const output = process.env.OUTPUT_DIR || 'results';
await mkdir(output, { recursive: true });
const variants = ['name-email', 'phone-auto-consent', 'phone-unchecked-consent'];
const telemetry = [];
const lag = monitorEventLoopDelay({ resolution: 20 });
let previousCpu = cpuTimes();
function cpuTimes() {
  return os.cpus().reduce((total, cpu) => ({
    idle: total.idle + cpu.times.idle,
    all: total.all + Object.values(cpu.times).reduce((a, b) => a + b, 0),
  }), { idle: 0, all: 0 });
}
function sampleHost() {
  const now = cpuTimes();
  const delta = now.all - previousCpu.all;
  telemetry.push({ at: Date.now(), cpuPercent: delta ? 100 * (1 - (now.idle - previousCpu.idle) / delta) : 0,
    freeRamGB: os.freemem() / 2 ** 30 });
  previousCpu = now;
}

function observePage() {
  window.__loadMetrics = { lcpMs: null, maxEventMs: null, longTaskCount: 0, maxLongTaskMs: 0 };
  for (const type of ['largest-contentful-paint', 'event', 'longtask']) {
    if (!PerformanceObserver.supportedEntryTypes.includes(type)) continue;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (type === 'largest-contentful-paint') window.__loadMetrics.lcpMs = entry.startTime;
        if (type === 'event' && entry.interactionId) {
          window.__loadMetrics.maxEventMs = Math.max(window.__loadMetrics.maxEventMs || 0, entry.duration);
        }
        if (type === 'longtask') {
          window.__loadMetrics.longTaskCount++;
          window.__loadMetrics.maxLongTaskMs = Math.max(window.__loadMetrics.maxLongTaskMs, entry.duration);
        }
      }
    });
    observer.observe({ type, buffered: true, ...(type === 'event' ? { durationThreshold: 16 } : {}) });
  }
}

const channel = process.env.BROWSER_CHANNEL;
const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}),
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });

async function newSession(id) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-IN' });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.addInitScript(observePage);
  return { id, context, page };
}

async function journey({ id, context, page }, submit) {
  const variant = id % 3;
  const email = `${emailStem}${emailStart + id}@${emailDomain}`;
  const result = { id, variant: variants[variant], email, submitted: false, successful: false,
    navigationStartedAt: null, errors: [], javascriptErrors: [], failedRequests: [] };
  page.on('pageerror', (error) => result.javascriptErrors.push(error.message));
  page.on('requestfailed', (request) => result.failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame() && result.navigationStartedAt === null) {
      result.navigationStartedAt = Date.now();
    }
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/waitlist/register') {
      result.submitted = true;
      const data = request.postDataJSON();
      result.payloadCorrect = data.name === `Loadtest ${runId} ${id + 1}` && data.email === email
        && data.mobileNumber === (variant === 0 ? null : phone) && data.whatsappUpdates === (variant === 1);
    }
  });
  try {
    const navigation = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const requestStart = navigation?.request().timing().startTime;
    if (Number.isFinite(requestStart) && requestStart >= 0) result.navigationStartedAt = requestStart;
    result.documentStatus = navigation?.status();
    if (!navigation?.ok()) throw new Error(`Document returned HTTP ${navigation?.status()}.`);
    await page.locator('#waitlist-name').waitFor({ state: 'visible' });
    // Trigger below-the-fold lazy images through scrolling, preserving normal page behavior.
    await page.evaluate(async () => {
      const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight * 0.8) {
        window.scrollTo({ top: y, behavior: 'instant' });
        await frame();
      }
      await document.fonts.ready;
    });
    await page.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0),
      null, { timeout: 30000 });
    await page.waitForLoadState('load', { timeout: 30000 });
    await page.locator('#waitlist-name').scrollIntoViewIfNeeded();
    result.pageReadyMs = await page.evaluate(() => performance.now());
    result.pageWithin5s = result.pageReadyMs <= 5000;

    const name = `Loadtest ${runId} ${id + 1}`;
    const fields = [['#waitlist-name', name], ['#waitlist-email', email]];
    if (variant !== 0) fields.push(['#waitlist-mobile-number', phone]);
    const chars = fields.reduce((count, [, value]) => count + value.length, 0);
    const delay = Math.max(1, Math.floor(1100 / chars));
    const fillStart = performance.now();
    for (const [selector, value] of fields) {
      await page.locator(selector).pressSequentially(value, { delay });
      if (await page.locator(selector).inputValue() !== value) throw new Error(`Input did not retain its value: ${selector}`);
    }
    const consent = page.locator('#waitlist-whatsapp');
    if (variant === 0) {
      if (await consent.isChecked() || await consent.isEnabled()) throw new Error('Consent must be unchecked and disabled without a phone.');
    } else {
      await page.waitForFunction(() => {
        const input = document.querySelector('#waitlist-whatsapp');
        return input?.checked && !input.disabled;
      }, null, { timeout: 3000 });
      result.autoChecked = true;
      if (variant === 2) await consent.uncheck();
      if (await consent.isChecked() !== (variant === 1)) throw new Error('Consent state does not match the scenario.');
    }
    result.fillMs = performance.now() - fillStart;
    result.fillWithin2s = result.fillMs <= 2000;
    if (result.fillMs < 2000) await new Promise((resolve) => setTimeout(resolve, 2000 - result.fillMs));

    if (submit) {
      const clickStart = performance.now();
      const responsePromise = page.waitForResponse((response) => response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/waitlist/register', { timeout: 30000 });
      responsePromise.catch(() => {});
      await page.getByRole('button', { name: 'Let’s go!', exact: true }).click();
      const response = await responsePromise;
      result.signupStatus = response.status();
      if (response.status() !== 202 || (await response.json()).accepted !== true) {
        throw new Error(`Signup returned HTTP ${response.status()}.`);
      }
      await page.getByRole('heading', { name: 'You’re on the waitlist!', exact: true }).waitFor({ state: 'visible' });
      result.clickToSuccessMs = performance.now() - clickStart;
      if (!result.payloadCorrect) throw new Error('Submitted payload differs from the expected scenario.');
    }
    result.successful = true;
  } catch (error) {
    result.errors.push(error.message);
    await page.screenshot({ path: `${output}/failure-${id}.png` }).catch(() => {});
  } finally {
    result.browserMetrics = await page.evaluate(() => ({ ...window.__loadMetrics,
      navigation: performance.getEntriesByType('navigation')[0]?.toJSON(),
      transferredBytes: performance.getEntriesByType('resource').reduce((sum, entry) => sum + entry.transferSize, 0),
    })).catch(() => null);
    await context.close();
  }
  console.log(`User ${id + 1}: ${result.variant}, ready=${result.pageReadyMs?.toFixed(0) ?? '?'}ms, fill=${result.fillMs?.toFixed(0) ?? '?'}ms, ${result.successful ? 'OK' : result.errors.join('; ')}`);
  return result;
}

const results = [];
let monitor;
try {
  if (mode === 'preflight') {
    lag.enable();
    monitor = setInterval(sampleHost, 1000);
    for (const id of ids) results.push(await journey(await newSession(id), false));
  } else {
    const requiredGB = 1 + ids.length * 0.25;
    if (os.freemem() / 2 ** 30 < requiredGB) throw new Error(`This shard needs at least ${requiredGB.toFixed(1)} GB free RAM; distribute users across more runners.`);
    const sessions = await Promise.all(ids.map(newSession));
    const startAt = process.env.START_AT ? Date.parse(process.env.START_AT) : Date.now() + 2000;
    if (!Number.isFinite(startAt) || startAt < Date.now() + 500) throw new Error('The synchronized start was missed. This shard will not submit.');
    console.log(`${sessions.length} cold sessions ready; waiting for ${new Date(startAt).toISOString()}.`);
    const waitLog = setInterval(() => console.log('Ready; waiting for synchronized arrival.'), 30000);
    await new Promise((resolve) => setTimeout(resolve, startAt - Date.now()));
    clearInterval(waitLog);
    lag.enable();
    previousCpu = cpuTimes();
    monitor = setInterval(sampleHost, 1000);
    results.push(...await Promise.all(sessions.map((session) => journey(session, true))));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  clearInterval(monitor);
  sampleHost();
  lag.disable();
  const document = { mode, shardIndex, shardCount, target: target.href, expectedUsers: mode === 'preflight' ? 3 : users,
    host: { cores: os.cpus().length, ramGB: os.totalmem() / 2 ** 30,
      eventLoopP95Ms: Number.isFinite(lag.percentile(95)) ? lag.percentile(95) / 1e6 : null }, telemetry, results };
  await writeFile(`${output}/${mode}-shard-${shardIndex}.json`, JSON.stringify(document, null, 2));
  await browser.close();
}
if (results.length !== ids.length || results.some((result) => !result.successful
    || (mode === 'burst' && (!result.pageWithin5s || !result.fillWithin2s)))) process.exitCode = 1;
