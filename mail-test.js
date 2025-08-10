import nodemailer from 'nodemailer';

const { MAIL_FROM, MAIL_TO, GMAIL_APP_PWD } = process.env;

async function main() {
  const tx = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: MAIL_FROM, pass: GMAIL_APP_PWD }
  });

  const subject = 'WMAR test email (daily thread)'; // keep fixed for threading
  await tx.sendMail({
    from: MAIL_FROM,
    to: MAIL_TO,
    subject,
    text: 'If you see this, SMTP is working. You can delete this later.'
  });

  console.log('Email sent ✅');
}
main().catch(err => { console.error(err); process.exit(1); });
