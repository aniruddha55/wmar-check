// LATEST this is latest
// wmar.js
import { chromium } from '@playwright/test';
import nodemailer from 'nodemailer';
import fs from 'fs';

// ---------- config ----------
const SUBJECT = process.env.MAIL_SUBJECT || 'WMAR — amended return (daily)';
const RESULT_SHOT = (process.env.RESULT_SHOT ?? '0') === '1';
const STATE_FILE = process.env.STATE_PATH || ''; // e.g. ".wmar_state.json" to enable "No change since yesterday"

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
  await tx.sendMail({ from: MAIL_FROM, to: MAIL_TO, subject, text, attachments });
}
async function innerTextSafe(target, selector, fallback='') {
  try {
    const loc = target.locator(selector);
    if ((await loc.count()) === 0) return fallback;
    return await loc.first().innerText();
  } catch { return fallback; }
}
function pickStatusAndLine(fullText) {
  const text = (fullText || '').replace(/\s+\n/g, '\n').replace(/\n{2,}/g, '\n\n');
  const m = text.match(/Your amended return [^\n.]+(?:\.)/i);
  const keyLine = m ? m[0].trim() : '';
  let status = '';
  if (/has not yet been processed/i.test(text)) status = 'received';
  else if (/adjusted/i.test(text)) status = 'adjusted';
  else if (/completed/i.test(text)) status = 'completed';
  else if (/does not match our records/i.test(text)) status = 'not-found';
  else status = 'unknown';
  return { status, keyLine: keyLine || text.slice(0, 200).trim() };
}
function loadPrevState() {
  if (!STATE_FILE) return null;
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}
function saveState(obj) {
  if (!STATE_FILE) return;
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2)); } catch {}
}
function appendHistory(row){
  try{
    const f = '.wmar_history.json';
    let arr = []; try { arr = JSON.parse(fs.readFileSync(f,'utf8')); } catch {}
    arr.push(row); fs.writeFileSync(f, JSON.stringify(arr.slice(-365), null, 2));
  }catch{}
}

// ---------- helpers to find contexts ----------
async function findFrameWith(page, testFn, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const f of page.frames()) {
      try { if (await testFn(f)) return f; } catch {}
    }
    await page.waitForTimeout(300);
  }
  return null;
}
async function getFormContext(page, steps, attempt=1) {
  // A) Top page?
  try {
    const topInputs = page.locator('main input, form input');
    await topInputs.first().waitFor({ state: 'visible', timeout: attempt === 1 ? 3000 : 6000 });
    if ((await topInputs.count()) >= 3) { steps.push('formCtx:top'); return page; }
  } catch {}
  // B) Any frame with >=3 inputs
  const f = await findFrameWith(page, async fr => (await fr.locator('input').count()) >= 3, attempt === 1 ? 8000 : 15000);
  if (f) { steps.push(`formCtx:frame:${f.url()}`); return f; }
  return null;
}
async function getYearContext(page, steps) {
  // Year select can also sometimes be top‑page
  try {
    const btn = page.getByRole('button', { name: /^continue$/i });
    const radios = page.getByRole('radio');
    if ((await btn.count()) > 0 && (await radios.count()) > 0) { steps.push('yearCtx:top'); return page; }
  } catch {}
  const f = await findFrameWith(page, async fr =>
    (await fr.getByRole('button', { name: /^continue$/i }).count()) > 0 &&
    (await fr.getByRole('radio').count()) > 0, 15000);
  if (f) { steps.push(`yearCtx:frame:${f.url()}`); return f; }
  return null;
}
async function getResultContext(page, steps) {
  try {
    if ((await page.locator('h1').count()) > 0) { steps.push('resultCtx:top'); return page; }
  } catch {}
  const f = await findFrameWith(page, async fr => (await fr.locator('h1').count()) > 0, 20000);
  if (f) { steps.push(`resultCtx:frame:${f.url()}`); return f; }
  return null;
}

// ---------- fill inside a context (page or frame) ----------
async function fillInside(ctx, { ssn, dob, zip }, steps) {
  // labels
  try {
    const ssnI = ctx.getByLabel(/Social Security number/i);
    const dobI = ctx.getByLabel(/Date of birth/i);
    const zipI = ctx.getByLabel(/Zip or Postal code/i);
    await Promise.all([
      ssnI.waitFor({ state: 'visible', timeout: 2000 }),
      dobI.waitFor({ state: 'visible', timeout: 2000 }),
      zipI.waitFor({ state: 'visible', timeout: 2000 }),
    ]);
    await ssnI.fill(ssn); await dobI.fill(dob); await zipI.fill(zip);
    steps.push('fill:labels'); return;
  } catch {}
  // css
  try {
    await ctx.locator('input[name="tin"], input[id*="ssn"], input[aria-label*="Social"]').first().fill(ssn, { timeout: 2000 });
    await ctx.locator('input[name*="dob"], input[aria-label*="Date of birth"]').first().fill(dob);
    await ctx.locator('input[name*="zip"], input[aria-label*="Zip"]').first().fill(zip);
    steps.push('fill:css'); return;
  } catch {}
  // dom
  await ctx.waitForSelector('input', { timeout: 5000 });
  await ctx.evaluate(({ ssn, dob, zip }) => {
    const root = document.querySelector('main') || document;
    const ins = Array.from(root.querySelectorAll('input'));
    if (ins.length < 3) throw new Error('inputs not found');
    const set = (el,val)=>{ el.value=val; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); };
    set(ins[0], ssn); set(ins[1], dob); set(ins[2], zip);
  }, { ssn, dob, zip });
  steps.push('fill:dom');
}

// ---------- main ----------
(async () => {
  const ssn = formatSSN(process.env.IRS_SSN);
  const dob = (process.env.IRS_DOB || '').trim();
  const zip = (process.env.IRS_ZIP || '').trim();

  const VERIFY_MS            = Number(process.env.VERIFY_MS || 0);
  const PAUSE_BEFORE_YEAR_MS = Number(process.env.PAUSE_BEFORE_YEAR_MS || 0);
  const PAUSE_AFTER_YEAR_MS  = Number(process.env.PAUSE_AFTER_YEAR_MS || 0);
  const SLOW_FLOW_MS         = Number(process.env.SLOW_FLOW_MS || 0);
  const doSubmit             = (process.env.SUBMIT ?? '1') !== '0';
  const head = process.env.HEAD === '1';

  const browser = await chromium.launch({
    headless: !head,
    slowMo: head ? 200 : 0,
    args: ['--disable-blink-features=AutomationControlled']
  });
  const ctx = await browser.newContext({
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36',
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 }
  });
  await ctx.addInitScript(() => {
    // reduce “headless” fingerprints a bit
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);

  const steps = [];
  const log  = s => { steps.push(s); console.log('STEP:', s, 'URL:', page.url()); };
  const slow = async () => { if (SLOW_FLOW_MS > 0) await page.waitForTimeout(SLOW_FLOW_MS); };
  const shot = async (name) => { try { await page.screenshot({ path: name, fullPage: true }); } catch {} };

  try {
    // 1) Shared secrets (with retries + top/iframe fallback)
    log('goto:/wmar');
    await page.goto('https://sa.www4.irs.gov/wmar/', { waitUntil: 'domcontentloaded' }); await slow();

    let formCtx = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      log(`goto:/wmar/sharedSecrets (attempt ${attempt})`);
      await page.goto('https://sa.www4.irs.gov/wmar/sharedSecrets', { waitUntil: attempt === 1 ? 'domcontentloaded' : 'networkidle' });
      await slow();
      formCtx = await getFormContext(page, steps, attempt);
      if (formCtx) break;
      await shot(`wmar-noform-a${attempt}.png`);
      await page.waitForTimeout(1000);
    }
    if (!formCtx) throw new Error('Could not find form for formFrame');

    log('fill-form');
    await fillInside(formCtx, { ssn, dob, zip }, steps); await slow();
    if (VERIFY_MS > 0) { await page.waitForTimeout(VERIFY_MS); }

    if (!doSubmit) { console.log('SUBMIT=0, stop after fill'); await new Promise(()=>{}); return; }

    log('submit(formCtx)');
    const submit1 = formCtx.getByRole('button', { name:/submit/i });
    if (await submit1.isVisible().catch(()=>false)) await submit1.click();
    else await formCtx.locator('button[type="submit"], input[type="submit"]').first().click({ force:true });
    await slow();

    if (PAUSE_BEFORE_YEAR_MS > 0) await page.waitForTimeout(PAUSE_BEFORE_YEAR_MS);

    await page.waitForLoadState('domcontentloaded');
    if (page.url().includes('/serviceUnavailable')) {
      log('serviceUnavailable:retry once');
      const backBtn = page.getByRole('button', { name: /Go back to Amended Return/i });
      if (await backBtn.isVisible().catch(()=>false)) { await backBtn.click(); await page.waitForLoadState('domcontentloaded'); }
    }

    // 2) selectTaxYear (top or frame)
    if (page.url().includes('/selectTaxYear')) {
      log('get-year-ctx');
      const yearCtx = await getYearContext(page, steps);
      if (!yearCtx) { await shot('wmar-noyear.png'); throw new Error('Could not find year select'); }

      let selected = false;
      try { const label2023 = yearCtx.getByText(/^2023$/);
        if (await label2023.first().isVisible().catch(()=>false)) { await label2023.first().click({ timeout: 2000 }); selected = true; } } catch {}
      if (!selected) {
        const r2023 = yearCtx.getByRole('radio', { name: /2023/ }).first();
        if (await r2023.isVisible().catch(()=>false)) {
          await r2023.click({ timeout: 2000 }).catch(()=>{});
          await r2023.check({ force: true }).catch(()=>{});
          selected = true;
        }
      }
      if (!selected) {
        selected = await yearCtx.evaluate(() => {
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
          el.checked = true; el.click?.();
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        });
      }
      if (!selected) throw new Error('Could not select tax year');

      const cont = yearCtx.getByRole('button', { name:/^continue$/i });
      if (await cont.isVisible().catch(()=>false)) await cont.click();
      else await yearCtx.locator('button, input[type="submit"]').filter({ hasText:'Continue' }).first().click({ force:true });
      await slow();
      if (PAUSE_AFTER_YEAR_MS > 0) await page.waitForTimeout(PAUSE_AFTER_YEAR_MS);
    }

    // 3) Final page
    log('wait:/wmar/returnStatus');
    await page.waitForURL(u => u.toString().includes('/wmar/returnStatus'), { timeout: 70000 });
    await slow();

    log('get-result-ctx');
    const resCtx = await getResultContext(page, steps);
    if (!resCtx) { await shot('wmar-noresult.png'); throw new Error('Could not find result context'); }

    const heading  = await innerTextSafe(resCtx, 'h1', '');
    let fullBody   = await innerTextSafe(resCtx, 'main', '');
    if (!fullBody) fullBody = await innerTextSafe(resCtx, 'body', '');

    const { status, keyLine } = pickStatusAndLine(fullBody);

    // State & history
    let deltaNote = '';
    const prev = loadPrevState();
    if (prev && prev.status === status && prev.keyLine === keyLine) deltaNote = 'No change since yesterday.';
    saveState({ status, keyLine, ts: Date.now() });
    appendHistory({ ts: Date.now(), status, keyLine });

    // Screenshot attachment
    const attachments = [];
    if (RESULT_SHOT) {
      const p = `wmar-result-${Date.now()}.png`;
      try { await page.screenshot({ path: p, fullPage: true }); attachments.push({ filename: p, path: p }); } catch {}
    }

    const lines = [];
    lines.push(`Status: ${status}`);
    if (deltaNote) lines.push(deltaNote);
    if (keyLine) lines.push('', keyLine); else if (heading) lines.push('', heading);
    lines.push('\n---\nRaw:\n' + fullBody);

    await sendEmail(SUBJECT, lines.join('\n'), attachments);
    console.log('SUCCESS ::', steps.join(' > '));
    await browser.close();
  } catch (e) {
    const ts = Date.now();
    try { await page.screenshot({ path: `wmar-failure-${ts}.png`, fullPage: true }); } catch {}
    const msg = `Steps: ${steps.join(' > ')}\n\nError: ${e?.message || e}`;
    console.error('FAIL ::', msg);
    await sendEmail(SUBJECT, `[FAIL]\n\n${msg}`).catch(()=>{});
    await browser.close();
    process.exit(1);
  }
})();
