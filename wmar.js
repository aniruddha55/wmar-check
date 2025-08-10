import { chromium } from '@playwright/test';
import nodemailer from 'nodemailer';

// ----- helpers -----
function formatSSN(raw) {
  const d = (raw || '').replace(/\D/g, '');
  if (d.length !== 9) throw new Error('SSN must have 9 digits');
  return `${d.slice(0,3)}-${d.slice(3,5)}-${d.slice(5)}`;
}
async function sendEmail(subject, body) {
  const { MAIL_FROM, MAIL_TO, GMAIL_APP_PWD } = process.env;
  const tx = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: MAIL_FROM, pass: GMAIL_APP_PWD }
  });
  await tx.sendMail({ from: MAIL_FROM, to: MAIL_TO, subject, text: body });
}

(async () => {
  const ssn = formatSSN(process.env.IRS_SSN);
  const dob = (process.env.IRS_DOB || '').trim();   // MM/DD/YYYY
  const zip = (process.env.IRS_ZIP || '').trim();

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
  });
  const page = await ctx.newPage();

  const diag = [];
  const log = s => diag.push(s);

  try {
    log('goto');
    await page.goto('https://sa.www4.irs.gov/wmar/', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Handles the "Select tax year" screen (can appear first)
    async function clickContinueIfYearPage() {
      const cont = page.getByRole('button', { name: /^continue$/i });
      if (await cont.isVisible().catch(() => false)) {
        await cont.click();
        await page.waitForLoadState('networkidle');
      }
    }
    log('maybe-continue-1');
    await clickContinueIfYearPage();

    // Wait for the form (use generous fallbacks)
    log('wait-form');
    const ssnInput = page.getByLabel(/Social Security number/i);
    await Promise.race([
      ssnInput.waitFor({ state: 'visible', timeout: 25000 }),
      page.waitForSelector('input[name="tin"], input[id*="ssn"], input[aria-label*="Social"]', { timeout: 25000 })
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

    // Submit the form
    log('submit');
    const submit = page.getByRole('button', { name: /submit/i });
    if (await submit.isVisible().catch(() => false)) {
      await submit.click();
    } else {
      await page.locator('button[type="submit"]').first().click();
    }

    // Some flows bounce back to the year page; click Continue again if so.
    log('maybe-continue-2');
    await clickContinueIfYearPage();

    await page.waitForLoadState('networkidle', { timeout: 30000 });

    // Extract result
    log('extract');
    const heading = await page.locator('h1').first().innerText().catch(() => '');
    const statusBlock = await page.locator('main').innerText().catch(() => 'Could not read status.');

    await sendEmail('IRS Amended Return Status — WMAR (daily)', `Heading: ${heading}\n\n${statusBlock}`);
  } catch (e) {
    const ts = Date.now();
    try { await page.screenshot({ path: `wmar-failure-${ts}.png`, fullPage: true }); } catch {}
    await sendEmail('WMAR check FAILED (daily)', `Steps: ${diag.join(' > ')}\n\nError: ${e}`);
    throw e;
  } finally {
    await browser.close();
  }
})();


