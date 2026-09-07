const { info, warn } = require('../utils/logger');

function parseBool(value, fallback = false) {
  if (value == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function validateEnv() {
  process.env.PORT = process.env.PORT || '5000';
  const required = ['PORT', 'MONGO_URI', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'CLIENT_URL'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }

  process.env.WHATSAPP_ENABLED = String(parseBool(process.env.WHATSAPP_ENABLED, true));

  const r2Keys = ['R2_ENDPOINT', 'R2_ACCESS_KEY', 'R2_SECRET_KEY', 'R2_BUCKET'];
  const hasAnyR2 = r2Keys.some((k) => Boolean(process.env[k]));
  const hasFullR2 = r2Keys.every((k) => Boolean(process.env[k]));

  if (hasAnyR2 && !hasFullR2) {
    warn('R2 partially configured. Media upload to R2 may fail.', {
      missingR2: r2Keys.filter((k) => !process.env[k]),
    });
  }
  if (hasFullR2) {
    info('R2 configuration loaded');
  } else {
    warn('R2 is not configured. Media upload endpoint disabled.');
  }
}

module.exports = { validateEnv };
