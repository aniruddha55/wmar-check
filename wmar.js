// CI‑robust version: landing link → top OR iframe via frameLocator → diagnostics
import { chromium, firefox } from '@playwright/test';
import nodemailer from 'nodemailer';
import fs from 'fs';

// ---------- config ----------
const SUBJECT = process.env.MAIL_SUBJECT || 'WMAR — amended return (daily)';
const RESULT_SHOT = (process.env.RESULT_SHOT ?? '0') === '1';
const STATE_FILE = process.env.STATE_PATH || ''; // e.g. ".wmar_state.json"

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
function pickStatusAndLine(fullText) {
  const t = (fullText || '').replace(/\s+\n/g, '\n').replace(/\n{2,}/g, '\n\n');
  const m = t.match(/Your amended return [^\n.]+(?:\.)/i);
  const keyLine = m ? m[0].trim() : '';
  let status = '';
  if (/has not yet been processed/i.test(t)) status = 'received';
  else if (/adjusted/i.test(t)) status = 'adjusted';
  else if (/completed/i.test(t)) status = 'completed';
  else if (/does not match our records/i.test(t)) status = 'not-found';
  else status = 'unknown';
  return { status, keyLine: keyLine || t.slice(0, 200).trim() };
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

async function runOnce(engine = 'chromium') {
  const ssn = formatSSN(process.env.IRS_SSN);
  const dob = (process.env.IRS_DOB || '').trim();
  const zip = (process.env.IRS_ZIP || '').trim();

  const VERIFY_MS            = Number(process.env.VERIFY_MS || 0);
  const PAUSE_BEFORE_YEAR_MS = Number(process.env.PAUSE_BEFORE_YEAR_MS || 0);
  const PAUSE_AFTER_YEAR_MS  = Number(process.env.PAUSE_AFTER_YEAR_MS || 0);
  const SLOW_FLOW_MS         = Number(process.env.SLOW_FLOW_MS || 0);
  const doSubmit             = (process.env.SUBMIT ?? '1') !== '0';
  const head = process.env.HEAD === '1';

  const browserType = engine === 'firefox' ? firefox : chromium;
  const browser = await browserType.launch({
    headless: !head,
    slowMo: head ? 200 : 0,
    args: engine === 'chromium' ? ['--disable-blink-features=AutomationControlled'] : []
  });
  const ctx = await browser.newContext({
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36',
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 }
  });
  await ctx.addInitScript(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch {}
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(90000);

  const steps = [];
  const log  = s => { steps.push(s); console.log('STEP:', s, 'URL:', page.url()); };
  const slow = async () => { if (SLOW_FLOW_MS > 0) await page.waitForTimeout(SLOW_FLOW_MS); };
  const shot = async (name) => { try { await page.screenshot({ path: name, fullPage: true }); } catch {} };
  const dump = async (tag) => {
    try {
      await fs.promises.writeFile(`wmar-${tag}.html`, await page.content());
      await shot(`wmar-${tag}.png`);
      console.log('Frames:', page.frames().map(f => f.url()).join(' | '));
      console.log('Top inputs count:', await page.locator('main input, form input').count());
    } catch {}
  };

  try {
    // 1) Landing page (sets cookies) → then SharedSecrets
    log('goto:/wmar');
    await page.goto('https://sa.www4.irs.gov/wmar/', { waitUntil: 'networkidle' });
    await slow();
    try {
      const wmarLink = page.getByRole('link', { name: /Where's My Amended Return/i });
      if (await wmarLink.isVisible().catch(()=>false)) {
        await wmarLink.click();
        await page.waitForLoadState('networkidle');
      }
    } catch {}

    // 2) SharedSecrets: wait for either top inputs OR an iframe that contains the form
    for (let attempt = 1; attempt <= 3; attempt++) {
      log(`goto:/wmar/sharedSecrets (attempt ${attempt})`);
      await page.goto('https://sa.www4.irs.gov/wmar/sharedSecrets', { waitUntil: attempt === 1 ? 'domcontentloaded' : 'networkidle' });
      await slow();

      // race: top-page input or iframe input
      let found = false;
      try {
        await Promise.race([
          page.locator('main input, form input').first().waitFor({ state: 'visible', timeout: 4000 }),
          page.frameLocator('iframe').locator('input').first().waitFor({ state: 'visible', timeout: 4000 })
        ]);
        found = true;
      } catch {}
      if (!found) { await dump(`noform-a${attempt}`); continue; }

      // 3) Fill either on top page or iframe (prefer iframe if present)
      log('fill-form');
      const inIframe = await page.frameLocator('iframe').locator('input').first().isVisible().catch(()=>false);

      const root = inIframe ? page.frameLocator('iframe') : page;
      const ssnI = root.getByLabel(/Social Security number/i);
      const dobI = root.getByLabel(/Date of birth/i);
      const zipI = root.getByLabel(/Zip or Postal code/i);

      if (await ssnI.count().catch(()=>0)) {
        await ssnI.first().fill(ssn);
        await dobI.first().fill(dob);
        await zipI.first().fill(zip);
      } else {
        // fallback css
        await root.locator('input[id*="ssn"], input[name="tin"], input[aria-label*="Social"]').first().fill(ssn);
        await root.locator('input[name*="dob"], input[aria-label*="Date of birth"]').first().fill(dob);
        await root.locator('input[name*="zip"], input[aria-label*="Zip"]').first().fill(zip);
      }

      if (VERIFY_MS > 0) await page.waitForTimeout(VERIFY_MS);

      if (!doSubmit) { console.log('SUBMIT=0, stop after fill'); await new Promise(()=>{}); return await browser.close(); }

      log('submit');
      const submitBtn = root.getByRole('button', { name:/submit/i });
      if (await submitBtn.isVisible().catch(()=>false)) await submitBtn.click();
      else await root.locator('button[type="submit"], input[type="submit"]').first().click({ force:true });

      await slow();
      if (PAUSE_BEFORE_YEAR_MS > 0) await page.waitForTimeout(PAUSE_BEFORE_YEAR_MS);

      await page.waitForLoadState('domcontentloaded');
      if (page.url().includes('/serviceUnavailable')) {
        log('serviceUnavailable:retry once');
        const backBtn = page.getByRole('button', { name: /Go back to Amended Return/i });
        if (await backBtn.isVisible().catch(()=>false)) { await backBtn.click(); await page.waitForLoadState('domcontentloaded'); }
      }

      // 4) Year selection (top or iframe)
      if (page.url().includes('/selectTaxYear')) {
        log('year-select');
        const yRoot = (await page.frameLocator('iframe').getByRole('radio').count().catch(()=>0)) > 0
          ? page.frameLocator('iframe')
          : page;

        // select 2023
        let selected = false;
        try {
          const lab = yRoot.getByText(/^2023$/);
          if (await lab.first().isVisible().catch(()=>false)) { await lab.first().click(); selected = true; }
        } catch {}
        if (!selected) {
          const r = yRoot.getByRole('radio', { name: /2023/ }).first();
          if (await r.isVisible().catch(()=>false)) { await r.click().catch(()=>{}); await r.check({ force:true }).catch(()=>{}); selected = true; }
        }
        if (!selected) {
          // last‑ditch: DOM script
          await yRoot.locator('body').evaluate(() => {
            const lab = Array.from(document.querySelectorAll('label')).find(l => /2023/.test(l.textContent||''));
            let el = lab ? (lab.getAttribute('for') ? document.getElementById(lab.getAttribute('for')) : lab.querySelector('input[type=radio]')) : null;
            el = el || document.querySelector('input[type=radio]');
            if (el) { el.checked = true; el.click?.(); el.dispatchEvent(new Event('change', { bubbles: true })); }
          });
        }
        const cont = yRoot.getByRole('button', { name:/^continue$/i });
        if (await cont.isVisible().catch(()=>false)) await cont.click();
        else await yRoot.locator('button, input[type="submit"]').filter({ hasText:'Continue' }).first().click({ force:true });
        if (PAUSE_AFTER_YEAR_MS > 0) await page.waitForTimeout(PAUSE_AFTER_YEAR_MS);
      }

      // 5) Final status
      log('wait:/wmar/returnStatus');
      await page.waitForURL(u => u.toString().includes('/wmar/returnStatus'), { timeout: 70000 });

      const resRoot = (await page.frameLocator('iframe').locator('h1').count().catch(()=>0)) > 0
        ? page.frameLocator('iframe')
        : page;

      const heading = await resRoot.locator('h1').first().innerText().catch(()=> '');
      let body = await resRoot.locator('main').first().innerText().catch(()=> '');
      if (!body) body = await resRoot.locator('body').first().innerText().catch(()=> '');

      const { status, keyLine } = pickStatusAndLine(body);

      // state & history
      let deltaNote = '';
      const prev = loadPrevState();
      if (prev && prev.status === status && prev.keyLine === keyLine) deltaNote = 'No change since yesterday.';
      saveState({ status, keyLine, ts: Date.now() });
      appendHistory({ ts: Date.now(), status, keyLine });

      const attachments = [];
      if (RESULT_SHOT) {
        const p = `wmar-result-${Date.now()}.png`;
        try { await page.screenshot({ path: p, fullPage: true }); attachments.push({ filename: p, path: p }); } catch {}
      }

      const lines = [];
      lines.push(`Status: ${status}`);
      if (deltaNote) lines.push(deltaNote);
      if (keyLine) lines.push('', keyLine); else if (heading) lines.push('', heading);
      lines.push('\n---\nRaw:\n' + body);

      await sendEmail(SUBJECT, lines.join('\n'), attachments);
      console.log('SUCCESS ::', steps.join(' > '));
      await browser.close();
      return;
    }

    // If loop finished without success:
    await dump('noform-final');
    throw new Error('Could not find form after retries');
  } catch (e) {
    const ts = Date.now();
    try { await fs.promises.writeFile(`wmar-failure-${ts}.html`, await page.content()); } catch {}
    try { await page.screenshot({ path: `wmar-failure-${ts}.png`, fullPage: true }); } catch {}
    const msg = `Error: ${e?.message || e}`;
    console.error(msg);
    await browser.close();
    throw e;
  }
}

(async () => {
  try {
    await runOnce('chromium');
  } catch {
    // Fallback: try Firefox once (sometimes bypasses headless heuristics)
    try {
      console.log('Retrying with Firefox…');
      await runOnce('firefox');
    } catch (e2) {
      const subject = SUBJECT;
      const body = `[FAIL]\nSee attached artifacts. ${e2?.message || e2}`;
      await sendEmail(subject, body).catch(()=>{});
      process.exit(1);
    }
  }
})();
