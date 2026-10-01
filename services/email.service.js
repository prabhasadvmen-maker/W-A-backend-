const nodemailer = require('nodemailer');
const axios = require('axios');

function getTransporter() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth:
      process.env.SMTP_USER && process.env.SMTP_PASS
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
  });
}

async function sendWelcomeEmail(to, name) {
  const transport = getTransporter();
  if (!transport) return;
  const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@localhost';
  await transport.sendMail({
    from,
    to,
    subject: 'Welcome to WhatsApp Marketing SaaS',
    text: `Hi ${name},\n\nYour account is ready. Connect WhatsApp in the dashboard to start sending campaigns.\n`,
  });
}

async function sendPasswordResetEmail(to, resetLink) {
  const transport = getTransporter();
  if (!transport) return;
  const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@localhost';
  await transport.sendMail({
    from,
    to,
    subject: 'Password reset',
    text: `Reset your password: ${resetLink}\n`,
  });
}

async function sendBulkEmailViaBrevo(recipients, subject, htmlBody, attachments = [], onProgress) {
  let sent = 0;
  let failed = 0;
  let processed = 0;

  if (process.env.USE_BREVO !== 'true' || !process.env.BREVO_API_KEY) {
    throw new Error('Brevo is not configured');
  }

  const sender = {
    name: process.env.BREVO_FROM_NAME || 'Sender',
    email: process.env.BREVO_FROM_EMAIL,
  };

  for (const recipient of recipients) {
    try {
      await axios.post(
        'https://api.brevo.com/v3/smtp/email',
        {
          sender,
          to: [{ email: recipient.email, name: recipient.name || undefined }],
          subject,
          htmlContent: htmlBody,
          ...(attachments && attachments.length > 0 ? { attachment: attachments } : {})
        },
        {
          headers: {
            'api-key': process.env.BREVO_API_KEY,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
        }
      );
      sent++;
    } catch (error) {
      console.error(`Failed to send email to ${recipient.email}:`, error.response?.data || error.message);
      failed++;
    }
    processed++;
    if (onProgress) {
      onProgress({ processed, total: recipients.length, sent, failed, currentRecipient: recipient, error: null }); // Can adjust based on need
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  if (onProgress) {
    onProgress({ processed, total: recipients.length, sent, failed, done: true });
  }

  return { sent, failed };
}


module.exports = { sendWelcomeEmail, sendPasswordResetEmail, getTransporter, sendBulkEmailViaBrevo };
