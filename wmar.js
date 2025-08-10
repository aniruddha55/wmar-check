// wmar.js
import { chromium } from '@playwright/test';
import nodemailer from 'nodemailer';
import fs from 'fs';

// ---------- config ----------
const SUBJECT = process.env.MAIL_SUBJECT || 'WMAR — amended return (daily)';
const RESULT_SHOT = (process.env.RESULT_SHOT ?? '0') === '1';
const STATE_FILE = process.env.STATE_PATH || ''; // e.g. ".wmar_state.json" (optional, enables "no change since yesterday")

// ---------- utils ----------
function formatSSN(raw) {
  const d = (raw || '').replace(/\D/g, '');
  if (d.length !== 9) throw new Error('SSN must have 9 digits');
  return `${d.slice(0,3)}-${d.slice(3,5)}-${d.slice(5)}`;
}
async function sendEmail(subject, text, attachments=[]) {
  const { MAIL_FROM, MAIL_TO, GMAIL_APP_PWD } = process.env;
  if (!MAIL_FROM || !MAIL_TO || !GMAIL_APP_PWD) return;
  const tx = nodemailer.createTransport({ service: 'gmail', auth: { user: MAIL_FROM, pass: GMAIL_APP_PWD } });
  // Force one thread in Gmail by keeping EXACT same subject each day
  await tx.sendMail({ from: MAIL_FROM, to: MAIL_TO, subject, text, attachments });
}
async function innerTextSafe(target, selector, fallback='') {
  try {
    const loc = target.locator(selector);
    const count = await loc.count();
    if (count === 0) return fallback;
    return await loc.first().innerText();
  } catch { return fallback; }
}

// ---------- frame helpers ----------
async function findFrameWith(page, testFn, steps, label, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const f of page.frames()) {
      try { if (await testFn(f)) { steps.push(`${label}:${f.url()}`); return f; } } catch {}
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`Could not find frame for ${label}`);
}
async function findFormFrame(page, steps) {
  return findFrameWith(page, async f => (await f.locator('input').count()) >= 3, steps, 'formFrame');
}
async function findYearFrame(page, steps) {
  return findFrameWith(page, async f =>
    (await f.getByRole('button', { name: /^continue$/i }).count()) > 0 &&
    (await f.getByRole('radio').count()) > 0, steps, 'yearFrame');
}
async function findResultFrame(page, steps) {
  return findFrameWith(page, async f => (await f.locator('h1').count()) > 0, steps, 'resultFrame', 25000);
}

// ---------- fill helpers ----------
async function fillInside(frame, { ssn, dob, zip }, steps) {
  try {
    const ssnI = frame.getByLabel(/Social Security number/i);
    const dobI = frame.getByLabel(/Date of birth/i);
    const zipI = frame.getByLabel(/Zip or Postal code/i);
    await Promise.all([
      ssnI.waitFor({ state: 'visible', timeout: 1500 }),
      dobI.waitFor({ state: 'visible', timeout: 1500 }),
      zipI.waitFor({ state: 'visible', timeout: 1500 }),
    ]);
    await ssnI.fill(ssn); await dobI.fill(dob); await zipI.fill(zip);
    steps.push('fill:labels'); return;
  } catch {}
  try {
    await frame.locator('input[name="tin"], input[id*="ssn"], input[aria-label*="Social"]').first().fill(ssn, { timeout: 1500 });
    await frame.locator('input[name*="dob"], input[aria-label*="Date of birth"]').first().fill(dob);
    await frame.locator('input[name*="zip"], input[aria-label*="Zip"]').first().fill(zip);
    steps.push('fill:css'); return;
  } catch {}
  await frame.waitForSelector('input', { timeout: 5000 });
  await frame.evaluate(({ ssn, dob, zip }) => {
    const root = document.querySelector('main') || document;
    const ins = Array.from(root.querySelectorAll('input'));
    if (ins.length < 3) throw new Error('inputs not found');
    const set = (el,val)=>{ el.value=val; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); };
    set(ins[0], ssn); set(ins[1], dob); set(ins[2], zip);
  }, { ssn, dob, zip });
  steps.push('fill:dom');
}

// ---------- parse status ----------
function pickStatusAndLine(fullText) {
  // normalize whitespace
  const text = (fullText || '').replace(/\s+\n/g, '\n').replace(/\n{2,}/g, '\n\n');
  // try to find the “Your amended return was …” sentence
  const m = text.match(/Your amended return [^\n.]+(?:\.)/i);
  const keyLine = m ? m[0].trim() : '';

  // heuristic for simple status
  let status = '';
  if (/has not yet been processed/i.test(text)) status = 'received';
  else if (/adjusted/i.test(text)) status = 'adjusted';
  else if (/completed/i.test(text)) status = 'completed';
  else if (/does not match our records/i.test(text)) status = 'not-found';
  else status = 'unknown';

  return { status, keyLine: keyLine || text.slice(0, 200).trim() };
}

// ---------- state helpers (optional “no change since yesterday”) ----------
function loadPrevState() {
  if (!STATE_FILE) return null;
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}
function saveState(obj) {
  if (!STATE_FILE) return;
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2)); } catch {}
}

// ---------- main ----------
(async () => {
  const ssn = formatSSN(process.env.IRS_SSN);
  const dob = (process.env.IRS_DOB || '').trim();   // MM/DD/YYYY
  const zip = (process.env.IRS_ZIP || '').trim();

  // Pauses / flags
  const VERIFY_MS            = Number(process.env.VERIFY_MS || 0);
  const PAUSE_BEFORE_YEAR_MS = Number(process.env.PAUSE_BEFORE_YEAR_MS || 0);
  const PAUSE_AFTER_YEAR_MS  = Number(process.env.PAUSE_AFTER_YEAR_MS || 0);
  const SLOW_FLOW_MS         = Number(process.env.SLOW_FLOW_MS || 0);
  const doSubmit             = (process.env.SUBMIT ?? '1') !== '0';

  const head = process.env.HEAD === '1';
  const browser = await chromium.launch({ headless: !head, slowMo: head ? 200 : 0 });
  const ctx = await browser.newContext({
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36',
    ignoreHTTPSErrors: true
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);

  const steps = [];
  const log  = s => { steps.push(s); console.log('STEP:', s, 'URL:', page.url()); };
  const slow = async () => { if (SLOW_FLOW_MS > 0) await page.waitForTimeout(SLOW_FLOW_MS); };

  try {
    // 1) sharedSecrets
    log('goto:/wmar');
    await page.goto('https://sa.www4.irs.gov/wmar/', { waitUntil: 'domcontentloaded' }); await slow();
    log('goto:/wmar/sharedSecrets');
    await page.goto('https://sa.www4.irs.gov/wmar/sharedSecrets', { waitUntil: 'domcontentloaded' }); await slow();

    log('find-form-frame');
    const formFrame = await findFormFrame(page, steps); await slow();

    log('fill-form');
    await fillInside(formFrame, { ssn, dob, zip }, steps); await slow();
    if (VERIFY_MS > 0) { console.log(`Pause ${VERIFY_MS}ms after fill`); await page.waitForTimeout(VERIFY_MS); }

    if (!doSubmit) { console.log('SUBMIT=0, stop after fill'); await new Promise(()=>{}); return; }

    log('submit(formFrame)');
    const submit1 = formFrame.getByRole('button', { name:/submit/i });
    if (await submit1.isVisible().catch(()=>false)) await submit1.click();
    else await formFrame.locator('button[type="submit"], input[type="submit"]').first().click({ force:true });
    await slow();

    if (PAUSE_BEFORE_YEAR_MS > 0) { await page.waitForTimeout(PAUSE_BEFORE_YEAR_MS); }

    await page.waitForLoadState('domcontentloaded');
    if (page.url().includes('/serviceUnavailable')) {
      log('serviceUnavailable:retry once');
      const backBtn = page.getByRole('button', { name: /Go back to Amended Return/i });
      if (await backBtn.isVisible().catch(()=>false)) { await backBtn.click(); await page.waitForLoadState('domcontentloaded'); }
    }

    // 2) selectTaxYear
    if (page.url().includes('/selectTaxYear')) {
      log('find-year-frame');
      const yearFrame = await findYearFrame(page, steps); await slow();

      let selected = false;
      try {
        const label2023 = yearFrame.getByText(/^2023$/);
        if (await label2023.first().isVisible().catch(()=>false)) { await label2023.first().click({ timeout: 2000 }); selected = true; }
      } catch {}
      if (!selected) {
        const r2023 = yearFrame.getByRole('radio', { name: /2023/ }).first();
        if (await r2023.isVisible().catch(()=>false)) { await r2023.click({ timeout: 2000 }).catch(()=>{}); await r2023.check({ force:true }).catch(()=>{}); selected = true; }
      }
      if (!selected) {
        selected = await yearFrame.evaluate(() => {
          const byLabel = () => {
            for (const lab of Array.from(document.querySelectorAll('label'))) {
              if (/2023/.test(lab.textContent || '')) {
                const forId = lab.getAttribute('for');
                return forId ? document.getElementById(forId) : lab.querySelector('input[type=radio]');
              }
            }
            return null;
          };
          let el = byLabel() || document.querySelector('input[type=radio]');
          if (!el) return false;
          el.checked = true;
          el.click?.();
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        });
      }
      if (!selected) throw new Error('Could not select tax year');

      log('continue(yearFrame)');
      const cont = yearFrame.getByRole('button', { name:/^continue$/i });
      if (await cont.isVisible().catch(()=>false)) await cont.click();
      else await yearFrame.locator('button, input[type="submit"]').filter({ hasText:'Continue' }).first().click({ force:true });
      await slow();
      if (PAUSE_AFTER_YEAR_MS > 0) { await page.waitForTimeout(PAUSE_AFTER_YEAR_MS); }
    }

    // 3) returnStatus
    log('wait:/wmar/returnStatus');
    await page.waitForURL(u => u.toString().includes('/wmar/returnStatus'), { timeout: 60000 });
    await slow();

    log('find-result-frame');
    let heading = '';
    let fullBody = '';
    try {
      const rFrame = await findResultFrame(page, steps);
      heading  = await innerTextSafe(rFrame, 'h1', '');
      fullBody = await innerTextSafe(rFrame, 'main', '');
      if (!fullBody) fullBody = await innerTextSafe(rFrame, 'body', '');
    } catch {
      heading  = await innerTextSafe(page, 'h1', '');
      fullBody = await innerTextSafe(page, 'main', '');
      if (!fullBody) fullBody = await innerTextSafe(page, 'body', '');
    }

    // Parse key info
    const { status, keyLine } = pickStatusAndLine(fullBody);

    // Compare with previous (optional)
    let deltaNote = '';
    const prev = loadPrevState();
    if (prev && prev.status === status && prev.keyLine === keyLine) {
      deltaNote = 'No change since yesterday.';
    }
    saveState({ status, keyLine, ts: Date.now() });

    // Optional screenshot
    const attachments = [];
    if (RESULT_SHOT) {
      const p = `wmar-result-${Date.now()}.png`;
      try { await page.screenshot({ path: p, fullPage: true }); attachments.push({ filename: p, path: p }); } catch {}
    }

    // Build concise email
    const lines = [];
    lines.push(`Status: ${status}`);
    if (deltaNote) lines.push(deltaNote);
    if (keyLine) { lines.push('', keyLine); }
    else { lines.push('', heading); }
    // Put raw text at bottom for reference (collapsed in Gmail unless expanded)
    lines.push('\n---\nRaw:\n' + fullBody);

    await sendEmail(SUBJECT, lines.join('\n'), attachments);
    console.log('SUCCESS ::', steps.join(' > '));
    await browser.close();
  } catch (e) {
    const ts = Date.now();
    try { await page.screenshot({ path: `wmar-failure-${ts}.png`, fullPage: true }); } catch {}
    const msg = `Steps: ${steps.join(' > ')}\n\nError: ${e?.message || e}`;
    console.error('FAIL ::', msg);
    // IMPORTANT: keep the SAME subject for one-thread behavior
    await sendEmail(SUBJECT, `[FAIL]\n\n${msg}`).catch(()=>{});
    await browser.close();
    process.exit(1);
  }
})();