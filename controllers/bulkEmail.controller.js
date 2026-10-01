const Contact = require('../models/Contact');
const Message = require('../models/Message');
const { sendBulkEmailViaBrevo } = require('../services/email.service');
const { emitToUser } = require('../services/socket.service');

exports.sendBulkEmail = async (req, res) => {
  try {
    const { subject, htmlBody, groupId, emails, attachments } = req.body;
    const userId = req.targetUserId || req.user._id;

    if (!subject || !htmlBody) {
      return res.status(400).json({ success: false, message: 'Subject and HTML body are required' });
    }

    let recipientsMap = new Map();

    if (emails && typeof emails === 'string') {
      const emailList = emails.split(/[\n,]+/).map(e => e.trim()).filter(e => e.includes('@'));
      for (const email of emailList) {
        if (!recipientsMap.has(email)) recipientsMap.set(email, '');
      }
    }

    if (groupId) {
      const contacts = await Contact.find({ userId, group: groupId, email: { $nin: ['', null] } });
      for (const contact of contacts) {
        if (contact.email && !recipientsMap.has(contact.email)) {
          recipientsMap.set(contact.email, contact.name);
        }
      }
    }

    const finalRecipients = Array.from(recipientsMap.entries()).map(([email, name]) => ({ email, name }));

    if (!finalRecipients.length) {
      return res.status(400).json({ success: false, message: 'No valid recipients found' });
    }

    if (finalRecipients.length > 100) {
      return res.status(400).json({ success: false, message: `Too many recipients (${finalRecipients.length}). Maximum 100 allowed per send.` });
    }

    res.status(200).json({ success: true, message: `Bulk email started for ${finalRecipients.length} recipients`, data: { total: finalRecipients.length } });

    setImmediate(async () => {
      await sendBulkEmailViaBrevo(finalRecipients, subject, htmlBody, attachments || [], async (progress) => {
        emitToUser(String(userId), 'bulkemail:progress', progress);

        if (progress.currentRecipient) {
          try {
            await Message.create({
              userId,
              direction: 'outbound',
              from: 'business',
              to: progress.currentRecipient.email,
              body: subject,
              type: 'email',
              status: progress.error ? 'failed' : 'sent',
              errorReason: progress.error ? String(progress.error) : '',
            });
          } catch (err) {
            console.error('[BulkEmail] Failed to save log:', err.message);
          }
        }
      });
    });
  } catch (error) {
    console.error('[BulkEmail] Send error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

exports.getBulkEmailHistory = async (req, res) => {
  try {
    const userId = req.targetUserId || req.user._id;

    const messages = await Message.find({ userId, type: 'email', direction: 'outbound' })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    const grouped = {};
    for (const msg of messages) {
      const minute = new Date(msg.createdAt);
      minute.setSeconds(0, 0);
      const key = `${msg.body}_${minute.getTime()}`;
      if (!grouped[key]) {
        grouped[key] = { id: key, subject: msg.body, date: minute.toISOString(), sent: 0, failed: 0, total: 0 };
      }
      grouped[key].total++;
      if (msg.status === 'sent') grouped[key].sent++;
      else grouped[key].failed++;
    }

    const history = Object.values(grouped).sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 50);
    return res.status(200).json({ success: true, data: { history }, message: 'Bulk email history' });
  } catch (error) {
    console.error('[BulkEmail] History error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};
