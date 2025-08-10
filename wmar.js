import { chromium } from '@playwright/test';
import nodemailer from 'nodemailer';

async function run() {
  const {
    IRS_SSN,          // e.g. 123-45-6789
    IRS_DOB,          // MM/DD/YYYY
    IRS_ZIP,          // e.g. 98036
    MAIL_FROM,        // your Gmail address
    MAIL_TO,          // where to send (can be same as from)
    GMAIL_APP_PWD     // Gmail "App password" (see note below)
  } = process.env;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // 1) Go to WMAR
  await page.goto('https://sa.www4.irs.gov/wmar/');

  // 2) Select tax year (the page usually shows 2023 radio by default)
  // If the first page is a "Select tax year" screen, click Continue.
  const continueBtn = page.getByRole('button', { name: /continue/i });
  if (await continueBtn.isVisible().catch(() => false)) {
    await continueBtn.click();
  }

  // 3) Fill form
  await page.getByLabel(/Social Security number/i).fill(IRS_SSN);
  await page.getByLabel(/Date of birth/i).fill(IRS_DOB);      // MM/DD/YYYY
  await page.getByLabel(/Zip or Postal code/i).fill(IRS_ZIP);
  await page.getByRole('button', { name: /submit/i }).click();

  // 4) Read result text (keep it simple & robust)
  await page.waitForLoadState('networkidle');
  const heading = await page.locator('h1').first().innerText().catch(() => '');
  // Grab the big status message block if present
  const statusBlock =
    await page.locator('main').innerText().catch(() => 'Could not read status.');
  await browser.close();

  const now = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });

  const subject = 'IRS Amended Return Status — WMAR (daily)'; // keep EXACT same subject for threading
  const body = [
    `Time: ${now} PT`,
    `Page heading: ${heading}`,
    '',
    'Status details:',
    statusBlock
  ].join('\n');

  // 5) Send email via Gmail SMTP
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: MAIL_FROM, pass: GMAIL_APP_PWD }
  });

  await transporter.sendMail({
    from: MAIL_FROM,
    to:   MAIL_TO,
    subject,            // same subject → same Gmail thread
    text: body
  });
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
