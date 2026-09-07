const User = require('../models/User');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const BotFlow = require('../models/BotFlow');
const whatsapp = require('../services/whatsapp.service');
const { emitToUser } = require('../services/socket.service');
const ugcService = require('../services/ugc.service');
const AIAgent = require('../models/AIAgent');
const mongoose = require('mongoose');
const PhotoshareFolder = require('../models/PhotoshareFolder');
const PhotosharePhoto = require('../models/PhotosharePhoto');
const r2Service = require('../services/r2.service');
const geminiService = require('../services/gemini.service');

const photoshareDebouncers = new Map();

exports.verifyWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || 'myverifytoken123';

  if (mode === 'subscribe' && token === verifyToken) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
};

function findNode(flow, nodeId) {
  return flow.nodes.find((n) => n.id === nodeId);
}

async function sendNodeResponse(userId, customerPhone, node, convId) {
  if (!node) return;
  const phone = String(customerPhone).replace(/\D/g, '');
  let replyText = '';
  let apiRes = null;

  try {
    if (node.type === 'message' || node.type === 'condition') {
      const text = node.content || '';
      if (!text) return;
      apiRes = await whatsapp.sendTextMessage(userId, phone, text);
      replyText = text;
    } else if (node.type === 'menu') {
      const body = node.content || 'Choose an option:';
      const opts = node.options || [];
      const buttons = opts.map((o) => ({ title: o.label }));
      if (buttons.length) {
        apiRes = await whatsapp.sendInteractiveMessage(userId, phone, buttons, body);
      } else {
        apiRes = await whatsapp.sendTextMessage(userId, phone, body);
      }
      replyText = body;
    }
  } catch (err) {
    const reason = err.response?.data?.error?.message || err.message || 'Bot send failed';
    await Message.create({
      userId,
      conversationId: convId || null,
      direction: 'outbound',
      from: 'bot',
      to: phone,
      body: node.content || '',
      type: 'text',
      status: 'failed',
      errorReason: reason,
    });
    return;
  }

  if (replyText) {
    await Message.create({
      userId,
      conversationId: convId || null,
      direction: 'outbound',
      from: 'bot',
      to: phone,
      body: replyText,
      type: 'text',
      status: 'sent',
      whatsappMessageId: apiRes?.messages?.[0]?.id || '',
    });
  }
}

async function sendExternalAgentReply(userId, conv, textBody) {
  const fs = require('fs');
  const path = require('path');
  const logPath = path.join(__dirname, '../debug_webhook.log');
  
  function logDebug(msg) {
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logPath, `[${timestamp}] ${msg}\n`);
    console.log(`[DEBUG Webhook] ${msg}`);
  }

  try {
    let aiReply = '';
    const groqService = require('../services/groq.service');
    logDebug(`Looking up AIAgent mapping for userId: ${userId}`);
    const mapping = await AIAgent.findOne({ userId });

    if (mapping && mapping.externalAgentId) {
      try {
        logDebug(`Sending query to external agent: ${mapping.externalAgentId}`);
        aiReply = await ugcService.askAgent(mapping.externalAgentId, textBody, conv.customerPhone);
        logDebug(`Received answer from external agent: "${aiReply}"`);
      } catch (agentErr) {
        logDebug(`External agent query failed: ${agentErr.message}`);
      }
    }

    // Fallback or primary Groq AI query if GROQ_API_KEY is set in .env
    if (!aiReply && process.env.GROQ_API_KEY) {
      logDebug(`Querying Groq AI Engine for question: "${textBody}"`);
      aiReply = await groqService.generateGroqReply(textBody);
      logDebug(`Received answer from Groq AI: "${aiReply}"`);
    }

    if (!aiReply) {
      logDebug(`AI reply is empty, skipping WhatsApp message send.`);
      return;
    }
    const phone = String(conv.customerPhone).replace(/\D/g, '');
    const apiRes = await whatsapp.sendTextMessage(userId, phone, aiReply);
    await Message.create({
      userId,
      conversationId: conv._id,
      direction: 'outbound',
      from: 'bot',
      to: phone,
      body: aiReply,
      type: 'text',
      status: 'sent',
      whatsappMessageId: apiRes?.messages?.[0]?.id || '',
    });
    emitToUser(String(userId), 'inbox:newMessage', {
      conversationId: String(conv._id),
    });
  } catch (err) {
    logDebug(`AI reply error: ${err.message}`);
  }
}

async function processBot(userId, conv, textBody) {
  if (conv.isAIPaused) {
    const fs = require('fs');
    const path = require('path');
    const logPath = path.join(__dirname, '../debug_webhook.log');
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] AI is paused (Human Mode) for phone ${conv.customerPhone}. Dropping message.\n`);
    return;
  }
  let flow;
  try {
    flow = await BotFlow.findOne({ userId });
  } catch {
    await sendExternalAgentReply(userId, conv, textBody);
    return;
  }

  const incoming = (textBody || '').trim().toLowerCase();
  const convId = conv._id;

  // No bot flow — use External Agent directly
  if (!flow?.nodes?.length) {
    await sendExternalAgentReply(userId, conv, textBody);
    return;
  }

  const trigger = (flow.triggerKeyword || 'hi').toLowerCase();

  if (conv.botContext?.awaitingMenu && conv.botContext.currentNodeId) {
    const current = findNode(flow, conv.botContext.currentNodeId);
    if (current?.type === 'menu' && current.options?.length) {
      const match = current.options.find(
        (o) =>
          String(o.value).toLowerCase() === incoming ||
          String(o.label).toLowerCase() === incoming
      );
      if (match) {
        const nextId = match.nextNodeId || '';
        if (nextId) {
          const next = findNode(flow, nextId);
          if (next) {
            await sendNodeResponse(userId, conv.customerPhone, next, convId);
            conv.botContext.currentNodeId = next.id;
            conv.botContext.awaitingMenu = next.type === 'menu';
            conv.botContext.flowId = flow._id;
            await conv.save();
            if (next.nextNodeId) {
              const chain = findNode(flow, next.nextNodeId);
              if (chain) {
                await sendNodeResponse(userId, conv.customerPhone, chain, convId);
                conv.botContext.currentNodeId = chain.id;
                conv.botContext.awaitingMenu = chain.type === 'menu';
                await conv.save();
              }
            }
          }
        } else {
          conv.botContext.awaitingMenu = false;
          conv.botContext.currentNodeId = '';
          await conv.save();
        }
        return;
      }
      // Menu option match nahi hua — External Agent se reply
      await sendExternalAgentReply(userId, conv, textBody);
      return;
    }
  }

  const triggered =
    incoming === trigger ||
    incoming.startsWith(`${trigger} `) ||
    incoming === 'hello' ||
    incoming === 'start';

  if (!triggered) {
    // Trigger word nahi — External Agent se reply
    await sendExternalAgentReply(userId, conv, textBody);
    return;
  }

  const start = flow.nodes[0];
  if (!start) return;

  await sendNodeResponse(userId, conv.customerPhone, start, convId);
  conv.botContext = {
    flowId: flow._id,
    currentNodeId: start.id,
    awaitingMenu: start.type === 'menu',
  };
  await conv.save();

  if (start.type !== 'menu' && start.nextNodeId) {
    const n2 = findNode(flow, start.nextNodeId);
    if (n2) {
      await sendNodeResponse(userId, conv.customerPhone, n2, convId);
      conv.botContext.currentNodeId = n2.id;
      conv.botContext.awaitingMenu = n2.type === 'menu';
      await conv.save();
    }
  }
}

async function handleInboundMessage(user, value) {
  const phoneNumberId = value.metadata?.phone_number_id;
  if (!phoneNumberId || phoneNumberId !== user.whatsappPhoneNumberId) return;

  const messages = value.messages || [];
  for (const m of messages) {
    const from = m.from;
    const name = value.contacts?.[0]?.profile?.name || '';
    let textBody = '';
    let mediaUrl = '';

    if (m.type === 'text') {
      textBody = m.text?.body || '';
    } else if (m.type === 'interactive' && m.interactive?.button_reply) {
      textBody =
        m.interactive.button_reply.title ||
        m.interactive.button_reply.id ||
        '';
    } else if (m.type === 'image') {
      textBody = m.image?.caption || '[image]';
      try {
        const mediaId = m.image?.id;
        if (mediaId) {
          const downloadRes = await whatsapp.downloadMedia(user._id, mediaId);
          const uploadRes = await r2Service.uploadBuffer({
            buffer: downloadRes.buffer,
            filename: `${mediaId}.jpg`,
            mimetype: downloadRes.mimeType,
            folder: `users/${user._id}/chat`
          });
          mediaUrl = uploadRes.url;
        }
      } catch (err) {
        console.error('Failed to download/upload regular chatbot image:', err);
      }
    } else {
      textBody = `[${m.type}]`;
    }

    let conv = await Conversation.findOne({ userId: user._id, customerPhone: from });
    if (!conv) {
      conv = await Conversation.create({
        userId: user._id,
        customerPhone: from,
        customerName: name,
        lastMessage: textBody,
        lastMessageAt: new Date(),
        unreadCount: 1,
      });
    } else {
      conv.customerName = name || conv.customerName;
      conv.lastMessage = textBody;
      conv.lastMessageAt = new Date();
      conv.unreadCount = (conv.unreadCount || 0) + 1;
      await conv.save();
    }

    const inbound = await Message.create({
      userId: user._id,
      conversationId: conv._id,
      direction: 'inbound',
      from,
      to: user.whatsappPhoneNumberId,
      body: textBody,
      type: m.type || 'text',
      mediaUrl: mediaUrl || '',
      status: 'delivered',
      whatsappMessageId: m.id || '',
    });

    emitToUser(String(user._id), 'inbox:newMessage', {
      conversationId: String(conv._id),
      message: inbound,
    });
    emitToUser(String(user._id), 'inbox:update', { conversationId: String(conv._id) });

    if (m.id) {
      try {
        await whatsapp.markMessageRead(user._id, m.id);
      } catch {
        /* ignore */
      }
    }

    // === PHOTOSHARE LOGIC BEGIN ===
    let handledByPhotoshare = false;

    // Check if the user is sending an image but has no active session
    if (m.type === 'image' && !conv.activePhotoshareFolderId) {
      const fallbackFolder = await PhotoshareFolder.findOne({ userId: user._id, isActive: true });
      if (fallbackFolder) {
        conv.activePhotoshareFolderId = fallbackFolder._id;
        await conv.save();
      }
    }

    const photoshareMatch = textBody.trim().match(/^(upload|joinevent|uploadevent)_([a-zA-Z0-9_-]+)$/i);

    if (photoshareMatch) {
      handledByPhotoshare = true;
      const code = photoshareMatch[2].trim();
      const folder = await PhotoshareFolder.findOne({
        $or: [
          { linkCode: code },
          { _id: mongoose.isValidObjectId(code) ? code : null }
        ]
      });

      if (!folder) {
        await whatsapp.sendTextMessage(user._id, from, '❌ Oops! Event or folder not found. Please check the QR code or link.');
      } else {
        const now = new Date();
        const startCheck = folder.startTime ? now >= folder.startTime : true;
        const endCheck = folder.endTime ? now <= folder.endTime : true;

        if (!folder.isActive) {
          await whatsapp.sendTextMessage(user._id, from, `❌ Sorry, the event "${folder.name}" is currently inactive.`);
        } else if (!startCheck) {
          await whatsapp.sendTextMessage(user._id, from, `⚠️ The event "${folder.name}" has not started yet! Uploads will open at ${new Date(folder.startTime).toLocaleString()}.`);
        } else if (!endCheck) {
          await whatsapp.sendTextMessage(user._id, from, `⚠️ Time is over! Photos are no longer being accepted for event: "${folder.name}".`);
        } else {
          conv.activePhotoshareFolderId = folder._id;
          await conv.save();
          await whatsapp.sendTextMessage(user._id, from, `🎉 Connected to "${folder.name}"!\n\nPlease send your photos now. You can also write a caption with them. Write 'exit' to stop.`);
        }
      }
    } else if (textBody.trim().toLowerCase() === 'exit' && conv.activePhotoshareFolderId) {
      handledByPhotoshare = true;
      conv.activePhotoshareFolderId = null;
      await conv.save();
      await whatsapp.sendTextMessage(user._id, from, '👋 Exited photoshare upload session. You can now chat normally.');
    } else if (conv.activePhotoshareFolderId) {
      const folder = await PhotoshareFolder.findById(conv.activePhotoshareFolderId);
      if (folder) {
        const now = new Date();
        const startCheck = folder.startTime ? now >= folder.startTime : true;
        const endCheck = folder.endTime ? now <= folder.endTime : true;

        if (!folder.isActive) {
          conv.activePhotoshareFolderId = null;
          await conv.save();
          await whatsapp.sendTextMessage(user._id, from, `❌ Sorry, the event "${folder.name}" is currently inactive.`);
          handledByPhotoshare = true;
        } else if (!startCheck) {
          await whatsapp.sendTextMessage(user._id, from, `⚠️ The event "${folder.name}" has not started yet! Uploads will open at ${new Date(folder.startTime).toLocaleString()}.`);
          handledByPhotoshare = true;
        } else if (!endCheck) {
          conv.activePhotoshareFolderId = null;
          await conv.save();
          await whatsapp.sendTextMessage(user._id, from, `⚠️ Time is over! Photos are no longer being accepted for event: "${folder.name}".`);
          handledByPhotoshare = true;
        } else if (m.type === 'image') {
          handledByPhotoshare = true;
          const mediaId = m.image.id;
          const caption = m.image.caption || '';

          try {
            console.log(`[Webhook Photoshare] Processing photo from ${from} for folder: ${folder.name}`);
            
            // Download photo
            const { buffer, mimeType } = await whatsapp.downloadMedia(user._id, mediaId);
            
            // Moderate photo using Gemini
            const mod = await geminiService.moderateImage(buffer, mimeType);
            if (!mod.valid) {
              await whatsapp.sendTextMessage(user._id, from, `⚠️ Photo rejected: ${mod.reason || 'Image is blur or inappropriate.'}`);
              
              await PhotosharePhoto.create({
                folderId: folder._id,
                senderName: name || conv.customerName || from,
                senderPhone: from,
                photoUrl: 'rejected',
                caption,
                isValid: false,
                moderationReason: mod.reason || 'Blur/Inappropriate',
                whatsappMessageId: m.id,
              });
            } else {
              // Upload photo to R2
              const uploadRes = await r2Service.uploadBuffer({
                buffer,
                filename: `${mediaId}.jpg`,
                mimetype: mimeType,
                folder: `photoshare/${folder._id}`
              });

              // Save in DB
              const photoDoc = await PhotosharePhoto.create({
                folderId: folder._id,
                senderName: name || conv.customerName || from,
                senderPhone: from,
                photoUrl: uploadRes.url,
                key: uploadRes.key,
                caption,
                isValid: true,
                whatsappMessageId: m.id,
              });

              // Send a debounced summary reply
              const debounceKey = `${user._id}_${from}`;
              if (photoshareDebouncers.has(debounceKey)) {
                clearTimeout(photoshareDebouncers.get(debounceKey).timer);
              }

              const currentVal = photoshareDebouncers.get(debounceKey) || { 
                count: 0, 
                folderName: folder.name, 
                folderLinkCode: folder.linkCode 
              };
              currentVal.count += 1;

              let clientUrl = process.env.CLIENT_URL || 'https://w-a-frontend.vercel.app';
              if (clientUrl.includes('localhost')) {
                clientUrl = 'https://w-a-frontend.vercel.app';
              }
              const galleryUrl = `${clientUrl}/gallery/${folder.linkCode}`;

              currentVal.timer = setTimeout(async () => {
                try {
                  const finalCount = currentVal.count;
                  photoshareDebouncers.delete(debounceKey);
                  
                  const msg = `🎉 Received ${finalCount} photo${finalCount > 1 ? 's' : ''}! They have been added to the live gallery wall.\n\n👁️ View the live wall here: ${galleryUrl}`;
                  await whatsapp.sendTextMessage(user._id, from, msg);
                } catch (sendErr) {
                  console.error('Failed to send debounced photoshare reply:', sendErr);
                }
              }, 5000);

              photoshareDebouncers.set(debounceKey, currentVal);

              // Emit via socket
              emitToUser(String(user._id), 'photoshare:newPhoto', {
                folderId: String(folder._id),
                photo: photoDoc,
              });
            }
          } catch (error) {
            console.error('[Webhook Photoshare Error]:', error);
            await whatsapp.sendTextMessage(user._id, from, '❌ Failed to process and save your photo. Please try again.');
          }
        }
      }
    }
    // === PHOTOSHARE LOGIC END ===

    if (!handledByPhotoshare && (m.type === 'text' || m.type === 'interactive') && textBody && !textBody.startsWith('[')) {
      await processBot(user._id, conv, textBody);
    }
  }
}

async function handleStatusUpdate(user, value) {
  const statuses = value.statuses || [];
  for (const s of statuses) {
    const id = s.id;
    const status = s.status;
    if (!id) continue;
    const map = { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' };
    const st = map[status];
    if (!st) continue;

    await Message.findOneAndUpdate(
      { userId: user._id, whatsappMessageId: id },
      { status: st }
    );
  }
}

exports.receiveWebhook = async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    fs.appendFileSync(
      path.join(__dirname, '../incoming_webhooks.log'),
      `[${new Date().toISOString()}] webhook received: ${JSON.stringify(req.body)}\n`
    );

    const body = req.body;
    if (body.object !== 'whatsapp_business_account') {
      return res.sendStatus(404);
    }

    const entries = body.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const value = change.value;
        const phoneNumberId = value?.metadata?.phone_number_id;
        if (!phoneNumberId) continue;

        const user = await User.findOne({ whatsappPhoneNumberId: phoneNumberId }).select(
          '+whatsappAccessToken'
        );
        if (!user) {
          console.log(`[Webhook] No user found for whatsappPhoneNumberId: ${phoneNumberId}`);
          continue;
        }
        console.log(`[Webhook] Message received for User: "${user.name}" (${user.email}) | ID: ${user._id} | PhoneID: ${phoneNumberId}`);

        if (value.messages) await handleInboundMessage(user, value);
        if (value.statuses) await handleStatusUpdate(user, value);
      }
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error:', e);
    return res.sendStatus(500);
  }
};
