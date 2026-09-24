const Contact = require('../models/Contact');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const Analytics = require('../models/Analytics');
const whatsapp = require('../services/whatsapp.service');
const { emitToUser } = require('../services/socket.service');
const { success, fail } = require('../utils/apiResponse');

async function upsertAnalyticsDay(userId, patch) {
  const Analytics = require('../models/Analytics');
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  await Analytics.findOneAndUpdate(
    { userId, date: start },
    { $inc: patch },
    { upsert: true, new: true }
  );
}

// POST /api/bulk/send
exports.sendBulkMessage = async (req, res) => {
  try {
    const { message, numbers, groupId, scheduleAt } = req.body;
    const userId = req.targetUserId || req.user._id;

    if (!message || !message.trim()) {
      return fail(res, 'Message text is required', 400);
    }

    let phoneList = [];

    // From contact group
    if (groupId) {
      const contacts = await Contact.find({
        userId,
        group: { $in: [groupId] },
        optedOut: false,
      }).select('phone name');
      phoneList = contacts.map((c) => ({ phone: c.phone.replace(/\D/g, ''), name: c.name || '' }));
    }

    // From manual numbers (comma/newline separated)
    if (numbers && numbers.trim()) {
      const manual = numbers
        .split(/[\n,]+/)
        .map((n) => n.trim().replace(/\D/g, ''))
        .filter((n) => n.length >= 10)
        .map((n) => ({ phone: n, name: '' }));
      phoneList = [...phoneList, ...manual];
    }

    // Deduplicate
    const seen = new Set();
    phoneList = phoneList.filter((p) => {
      if (seen.has(p.phone)) return false;
      seen.add(p.phone);
      return true;
    });

    if (!phoneList.length) {
      return fail(res, 'No valid phone numbers found', 400);
    }

    // Return immediately, process in background
    res.status(200).json({
      success: true,
      message: `Bulk send started for ${phoneList.length} contacts`,
      data: { total: phoneList.length },
    });

    // Background processing
    setImmediate(async () => {
      let sent = 0, failed = 0;

      for (let i = 0; i < phoneList.length; i++) {
        const { phone, name } = phoneList[i];
        try {
          const apiRes = await whatsapp.sendTextMessage(userId, phone, message.trim());
          const wamid = apiRes?.messages?.[0]?.id || '';

          // Upsert conversation
          let conv = await Conversation.findOne({ userId, customerPhone: phone });
          if (!conv) {
            conv = await Conversation.create({
              userId,
              customerPhone: phone,
              customerName: name,
              lastMessage: message.trim(),
              lastMessageAt: new Date(),
              unreadCount: 0,
            });
          } else {
            conv.lastMessage = message.trim();
            conv.lastMessageAt = new Date();
            await conv.save();
          }

          await Message.create({
            userId,
            conversationId: conv._id,
            direction: 'outbound',
            from: 'business',
            to: phone,
            body: message.trim(),
            type: 'text',
            status: 'sent',
            whatsappMessageId: wamid,
          });

          sent++;
          await upsertAnalyticsDay(userId, { sent: 1 });
        } catch (err) {
          failed++;
          await upsertAnalyticsDay(userId, { failed: 1 });
          console.error(`[BulkMessage] Failed to send to ${phone}:`, err.response?.data?.error?.message || err.message);
        }

        // Emit progress every 5 or on last
        if ((i + 1) % 5 === 0 || i === phoneList.length - 1) {
          emitToUser(String(userId), 'bulk:progress', {
            processed: i + 1,
            total: phoneList.length,
            sent,
            failed,
            done: i === phoneList.length - 1,
          });
        }

        // Rate limit: 1 message per 200ms
        await new Promise((r) => setTimeout(r, 200));
      }

      console.log(`[BulkMessage] Done — sent: ${sent}, failed: ${failed}`);
    });
  } catch (e) {
    return fail(res, e.message || 'Bulk send failed', 500);
  }
};

// GET /api/bulk/history
exports.getBulkHistory = async (req, res) => {
  try {
    const userId = req.targetUserId || req.user._id;
    const messages = await Message.find({
      userId,
      direction: 'outbound',
      from: 'business',
      type: 'text',
    })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    // Group by body + createdAt minute
    const grouped = {};
    for (const m of messages) {
      const minute = new Date(m.createdAt).toISOString().slice(0, 16);
      const key = `${minute}_${m.body?.slice(0, 30)}`;
      if (!grouped[key]) {
        grouped[key] = { message: m.body, sentAt: m.createdAt, sent: 0, failed: 0, numbers: [] };
      }
      if (m.status === 'failed') grouped[key].failed++;
      else grouped[key].sent++;
      grouped[key].numbers.push(m.to);
    }

    const history = Object.values(grouped).slice(0, 50);
    return success(res, { history }, 'Bulk history');
  } catch (e) {
    return fail(res, e.message || 'Failed to load history', 500);
  }
};
