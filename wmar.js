import { chromium } from '@playwright/test';
import nodemailer from 'nodemailer';

// ---------- helpers ----------
function formatSSN(raw) {
  const digits = (raw || '').replace(/\D/g, '');            // keep numbers only
  if (digits.length !== 9) throw new Error('SSN must have 9 digits');
  return `${digits.slice(0,3)}-${digits.slice(3,5)}-${digits.slice(5)}`;
}
function fmt(s) { return (s || '').trim(); }

async function sendEmail(subject, body) {
  const { MAIL_FROM, MAIL_TO, GMAIL_APP_PWD } = process.env;
  const tx = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: MAIL_FROM, pass: GMAIL_APP_PWD }
  });
  await tx.sendMail({ from: MAIL_FROM, to: MAIL_TO, subject, text: body });
}

// ---------- main ----------
(async () => {
  const {
    IRS_SSN, IRS_DOB, IRS_ZIP,
  } = process.env;

  const ssn = formatSSN(IRS_SSN); // <-- accepts with/without dashes
  const dob = fmt(IRS_DOB);       // keep as MM/DD/YYYY (page expects this)
  const zip = fmt(IRS_ZIP);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  const diag = [];
  const log = s => diag.push(s);

  try {
    log('goto');
    await page.goto('https://sa.www4.irs.gov/wmar/', { waitUntil: 'dom', timeout: 60000 });

    // If the "Select tax year" page appears first, click Continue
    log('check-continue');
    const contBtn = page.getByRole('button', { name: /^continue$/i });
    if (await contBtn.isVisible().catch(() => false)) {
      await contBtn.click();
      await page.waitForLoadState('networkidle');
    }

    // Wait for the form (be generous + fallbacks)
    log('wait-form');
    const ssnInput = page.getByLabel(/Social Security number/i);
    await Promise.race([
      ssnInput.waitFor({ state: 'visible', timeout: 20000 }),
      page.waitForSelector('input[name="tin"], input[id*="ssn"], input[aria-label*="Social"]', { timeout: 20000 })
    ]);

    // Fill SSN
    log('fill-ssn');
    if (await ssnInput.isVisible().catch(() => false)) {
      await ssnInput.fill(ssn);
    } else {
      await page.locator('input[name="tin"], input[id*="ssn"], input[aria-label*="Social"]').first().fill(ssn);
    }

    // Fill DOB
    log('fill-dob');
    const dobInput = page.getByLabel(/Date of birth/i);
    if (await dobInput.isVisible().catch(() => false)) {
      await dobInput.fill(dob);
    } else {
      await page.locator('input[aria-label*="Date of birth"], input[name*="dob"]').first().fill(dob);
    }

    // Fill ZIP
    log('fill-zip');
    const zipInput = page.getByLabel(/Zip or Postal code/i);
    if (await zipInput.isVisible().catch(() => false)) {
      await zipInput.fill(zip);
    } else {
      await page.locator('input[aria-label*="Zip"], input[name*="zip"]').first().fill(zip);
    }

    // Submit
    log('submit');
    const submit = page.getByRole('button', { name: /submit/i });
    if (await submit.isVisible().catch(() => false)) {
      await submit.click();
    } else {
      await page.locator('button[type="submit"]').first().click();
    }

    await page.waitForLoadState('networkidle', { timeout: 30000 });

    // Extract status
    log('extract');
    const heading = await page.locator('h1').first().innerText().catch(() => '');
    const statusBlock = await page.locator('main').innerText().catch(() => 'Could not read status.');

    const subject = 'IRS Amended Return Status — WMAR (daily)'; // keep fixed for threading
    const body = `Heading: ${heading}\n\n${statusBlock}`;
    await sendEmail(subject, body);
  } catch (err) {
    // Diagnostics: screenshot + failure email
    const ts = Date.now();
    try { await page.screenshot({ path: `wmar-failure-${ts}.png`, fullPage: true }); } catch {}
    await sendEmail('WMAR check FAILED (daily)', `Steps: ${diag.join(' > ')}\n\nError: ${err}`);
    throw err;
  } finally {
    await browser.close();
  }
})();


