const axios = require('axios');
const User = require('../models/User');

const apiVersion = () => process.env.WHATSAPP_API_VERSION || 'v19.0';

async function getCreds(userId) {
  const user = await User.findById(userId).select('+whatsappAccessToken');
  if (!user) {
    const err = new Error('User not found.');
    err.statusCode = 400;
    throw err;
  }

  // If user has their own credentials, use them
  if (user.whatsappPhoneNumberId && user.whatsappAccessToken) {
    return {
      phoneNumberId: user.whatsappPhoneNumberId,
      token: user.whatsappAccessToken,
    };
  }

  // Fallback: use parentAdmin's credentials (for client users)
  if (user.parentAdmin) {
    const admin = await User.findById(user.parentAdmin).select('+whatsappAccessToken');
    if (admin?.whatsappPhoneNumberId && admin?.whatsappAccessToken) {
      return {
        phoneNumberId: admin.whatsappPhoneNumberId,
        token: admin.whatsappAccessToken,
      };
    }
  }

  const err = new Error('WhatsApp not connected. Add Phone Number ID and Access Token.');
  err.statusCode = 400;
  throw err;
}

function graphUrl(phoneNumberId, path = '') {
  const base = `https://graph.facebook.com/${apiVersion()}/${phoneNumberId}`;
  return path ? `${base}/${path}` : base;
}

async function sendTextMessage(userId, to, message) {
  const { phoneNumberId, token } = await getCreds(userId);
  const toNum = String(to).replace(/\D/g, '');
  const url = graphUrl(phoneNumberId, 'messages');
  const { data } = await axios.post(
    url,
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toNum,
      type: 'text',
      text: { preview_url: false, body: String(message).slice(0, 4096) },
    },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  return data;
}

function buildTemplateComponents(params) {
  const components = [];

  // Check if params is an object containing header or body keys
  if (params && !Array.isArray(params) && (params.header || params.body)) {
    if (params.header && params.header.length) {
      components.push({
        type: 'header',
        parameters: params.header.map(val => {
          const isImg = /^https?:\/\/.+/i.test(val);
          return isImg ? { type: 'image', image: { link: val } } : { type: 'text', text: String(val) };
        })
      });
    }
    if (params.body && params.body.length) {
      components.push({
        type: 'body',
        parameters: params.body.map(val => ({
          type: 'text',
          text: String(val)
        }))
      });
    }
    return components;
  }

  // Fallback to array parameters (Old behavior)
  if (!params || !params.length) {
    return [{ type: 'body', parameters: [] }];
  }

  const headerParams = [];
  const bodyParams = [];

  for (const p of params) {
    const val = typeof p === 'string' ? p : String(p.text ?? p.value ?? p.parameter_name ?? '');
    
    // Check if the value is an image link (url ending with image extension or containing r2/s3 bucket details)
    const isImage = (p.parameter_name === 'header_image' || p.key === 'header_image') ||
                    /^https?:\/\/.+\.(jpg|jpeg|png|webp|gif)(\?.*)?$/i.test(val) || 
                    (val.startsWith('http') && (val.includes('r2.cloudflarestorage.com') || val.includes('r2.dev') || val.includes('cloudinary')));

    if (isImage) {
      headerParams.push({
        type: 'image',
        image: { link: val }
      });
    } else {
      bodyParams.push({
        type: 'text',
        text: val
      });
    }
  }

  if (headerParams.length > 0) {
    components.push({
      type: 'header',
      parameters: headerParams
    });
  }
  
  if (bodyParams.length > 0 || components.length === 0) {
    components.push({
      type: 'body',
      parameters: bodyParams
    });
  }

  return components;
}

async function sendTemplateMessage(userId, to, templateName, languageCode, params) {
  const { phoneNumberId, token } = await getCreds(userId);
  const toNum = String(to).replace(/\D/g, '');
  const url = graphUrl(phoneNumberId, 'messages');
  const bodyParams = buildTemplateComponents(params);
  const templatePayload = {
    name: templateName,
    language: { code: languageCode || 'en' },
  };
  if (bodyParams[0]?.parameters?.length) {
    templatePayload.components = bodyParams;
  }
  const { data } = await axios.post(
    url,
    {
      messaging_product: 'whatsapp',
      to: toNum,
      type: 'template',
      template: templatePayload,
    },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  return data;
}

async function sendMediaMessage(userId, to, type, mediaUrl, caption) {
  const { phoneNumberId, token } = await getCreds(userId);
  const toNum = String(to).replace(/\D/g, '');
  const url = graphUrl(phoneNumberId, 'messages');
  const mediaType = ['image', 'video', 'audio', 'document'].includes(type) ? type : 'image';
  const payload = {
    messaging_product: 'whatsapp',
    to: toNum,
    type: mediaType,
    [mediaType]: { link: mediaUrl },
  };
  if (caption && (mediaType === 'image' || mediaType === 'video' || mediaType === 'document')) {
    payload[mediaType].caption = String(caption).slice(0, 1024);
  }
  const { data } = await axios.post(url, payload, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  return data;
}

async function sendInteractiveMessage(userId, to, buttons, bodyText) {
  const { phoneNumberId, token } = await getCreds(userId);
  const toNum = String(to).replace(/\D/g, '');
  const url = graphUrl(phoneNumberId, 'messages');
  const list = (buttons || []).slice(0, 3).map((b, i) => ({
    type: 'reply',
    reply: { id: `btn_${i}`, title: String(b.title || b.label || b).slice(0, 20) },
  }));
  const { data } = await axios.post(
    url,
    {
      messaging_product: 'whatsapp',
      to: toNum,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: String(bodyText).slice(0, 1024) },
        action: { buttons: list },
      },
    },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  return data;
}

async function markMessageRead(userId, messageId) {
  const { phoneNumberId, token } = await getCreds(userId);
  const url = graphUrl(phoneNumberId, 'messages');
  const { data } = await axios.post(
    url,
    {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  return data;
}

/**
 * Meta Graph API se user ke WABA ke saare templates fetch karo
 * Returns array of template objects from Meta
 */
async function fetchMetaTemplates(userId) {
  const user = await User.findById(userId).select('+whatsappAccessToken');

  // Token: user DB se, warna .env fallback
  const token = user?.whatsappAccessToken || process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token) {
    const err = new Error('WhatsApp Access Token not configured. Please connect WhatsApp first in Settings.');
    err.statusCode = 400;
    throw err;
  }

  // WABA ID: user ke DB se, warna .env fallback
  const wabaId = user?.whatsappWabaId || process.env.WABA_ID || process.env.WHATSAPP_WABA_ID;
  if (!wabaId) {
    const err = new Error('WhatsApp Business Account ID (WABA_ID) not configured. Add it in Settings or .env file.');
    err.statusCode = 400;
    throw err;
  }

  const version = apiVersion();
  const url = `https://graph.facebook.com/${version}/${wabaId}/message_templates`;

  const { data } = await axios.get(url, {
    params: { limit: 250, fields: 'name,status,language,category,components' },
    headers: { Authorization: `Bearer ${token}` },
  });

  return data.data || [];
}

/**
 * Ek specific template name ko Meta se verify karo
 * Returns { found, status, components, language } 
 */
async function verifyMetaTemplate(userId, templateName) {
  const templates = await fetchMetaTemplates(userId);
  const match = templates.find(
    (t) => t.name.toLowerCase() === String(templateName).toLowerCase().trim()
  );
  if (!match) {
    return { found: false, status: null, components: [], language: null };
  }
  return {
    found: true,
    status: match.status, // 'APPROVED' | 'PENDING' | 'REJECTED' | 'DISABLED'
    language: match.language,
    category: match.category,
    components: match.components || [],
  };
}

/**
 * Meta WABA par directly naya template CREATE karo
 * @param {string} adminUserId - admin user ka ID (token + WABA ID ke liye)
 * @param {object} templateData - { name, category, language, bodyText, headerText, footerText, variables }
 * Returns Meta API response with template ID
 */
async function createMetaTemplate(adminUserId, templateData) {
  const user = await User.findById(adminUserId).select('+whatsappAccessToken');
  const token = user?.whatsappAccessToken || process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token) {
    const err = new Error('WhatsApp Access Token not configured.');
    err.statusCode = 400;
    throw err;
  }

  const wabaId = user?.whatsappWabaId || process.env.WABA_ID || process.env.WHATSAPP_WABA_ID;
  if (!wabaId) {
    const err = new Error('WABA_ID not configured. Add it in Settings.');
    err.statusCode = 400;
    throw err;
  }

  const { name, category, language, bodyText, headerText, footerText, headerVariables, bodyVariables } = templateData;

  // Components build karo
  const components = [];

  if (headerText && headerText.trim()) {
    const headerComponent = { type: 'HEADER', format: 'TEXT', text: headerText.trim() };
    if (headerVariables && headerVariables.length > 0) {
      headerComponent.example = { header_text: headerVariables };
    }
    components.push(headerComponent);
  }

  // Body component (required)
  const bodyComponent = { type: 'BODY', text: bodyText };
  // Agar variables hain to example add karo
  if (bodyVariables && bodyVariables.length > 0) {
    bodyComponent.example = {
      body_text: [bodyVariables],
    };
  }
  components.push(bodyComponent);

  if (footerText && footerText.trim()) {
    components.push({ type: 'FOOTER', text: footerText.trim() });
  }

  const version = apiVersion();
  const url = `https://graph.facebook.com/${version}/${wabaId}/message_templates`;

  const payload = {
    name: String(name).toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''),
    category: category || 'MARKETING',
    language: language || 'en',
    components,
  };

  const { data } = await axios.post(url, payload, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });

  return data; // { id, status } — Meta ka response
}

/**
 * Ek template ka latest Meta status refresh karo by name
 */
async function refreshTemplateStatus(adminUserId, templateName) {
  const result = await verifyMetaTemplate(adminUserId, templateName);
  return result;
}

/**
 * Download media binary from WhatsApp Graph API using media ID
 */
async function downloadMedia(userId, mediaId) {
  const { token } = await getCreds(userId);
  const version = apiVersion();

  // 1. Fetch media URL from Meta Graph API
  const metaUrl = `https://graph.facebook.com/${version}/${mediaId}`;
  const response = await axios.get(metaUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const downloadUrl = response?.data?.url;
  const mimeType = response?.data?.mime_type;
  if (!downloadUrl) {
    throw new Error('Failed to retrieve media download URL from WhatsApp API.');
  }

  // 2. Fetch the actual media binary content
  const mediaResponse = await axios.get(downloadUrl, {
    headers: { Authorization: `Bearer ${token}` },
    responseType: 'arraybuffer',
  });

  return {
    buffer: Buffer.from(mediaResponse.data),
    mimeType,
  };
}

module.exports = {
  sendTextMessage,
  sendTemplateMessage,
  sendMediaMessage,
  sendInteractiveMessage,
  markMessageRead,
  getCreds,
  fetchMetaTemplates,
  verifyMetaTemplate,
  createMetaTemplate,
  refreshTemplateStatus,
  downloadMedia,
};
