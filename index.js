require('dotenv').config({ override: true });
const http = require('http');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { validateEnv } = require('./config/env');
const connectDB = require('./config/db');
const { errorHandler, notFound } = require('./middleware/error.middleware');
const { initSocket } = require('./services/socket.service');
const { initScheduler } = require('./services/scheduler.service');
const { info, error } = require('./utils/logger');
const clientScope = require('./middleware/clientScope.middleware');

const authRoutes = require('./routes/auth.routes');
const contactRoutes = require('./routes/contact.routes');
const campaignRoutes = require('./routes/campaign.routes');
const messageRoutes = require('./routes/message.routes');
const templateRoutes = require('./routes/template.routes');
const botRoutes = require('./routes/bot.routes');
const inboxRoutes = require('./routes/inbox.routes');
const analyticsRoutes = require('./routes/analytics.routes');
const webhookRoutes = require('./routes/webhook.routes');
const adminRoutes = require('./routes/admin.routes');
const photoshareRoutes = require('./routes/photoshare.routes');
const partnerRoutes = require('./routes/partner.routes');
const bulkMessageRoutes = require('./routes/bulkMessage.routes');
const superadminRoutes = require('./routes/superadmin.routes');
const { protect } = require('./middleware/auth.middleware');
const authController = require('./controllers/auth.controller');

const app = express();
const server = http.createServer(app);

initSocket(server);

app.use(
  cors({
    origin: (origin, callback) => {
      const allowed = [
        process.env.CLIENT_URL,
        'http://localhost:5173',
        'http://localhost:3000',
      ].filter(Boolean);
      if (!origin || allowed.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, true); // allow all for now, restrict if needed
      }
    },
    credentials: true,
  })
);
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// Global API Key Security Middleware
app.use('/api', async (req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  if (req.path.startsWith('/webhook')) return next();
  if (req.path.startsWith('/health')) return next();
  if (req.path === '/auth/api-sharing-login') return next();
  if (req.path.startsWith('/partner')) return next();

  const providedKey = req.headers['x-api-key'];
  if (providedKey === (process.env.VALID_API_KEYS || 'whatsai-core-master-secret-key-2026')) {
    return next();
  }

  if (!providedKey) {
    return res.status(403).json({ success: false, message: 'Forbidden: Missing API Key' });
  }

  try {
    const User = require('./models/User');
    const userExists = await User.exists({ 
      'apiSharing.apiSharingKey': providedKey, 
      'apiSharing.isEnabled': true 
    });

    if (userExists) {
      return next();
    } else {
      return res.status(403).json({ success: false, message: 'Forbidden: Invalid API Sharing Key' });
    }
  } catch (err) {
    console.error('API Key DB Error:', err);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

app.use('/api/auth', authRoutes);
app.post('/api/whatsapp/connect', protect, clientScope, authController.connectWhatsApp);
app.post('/api/whatsapp/agent', protect, clientScope, authController.saveAIAgentId);
app.get('/api/whatsapp/agent', protect, clientScope, authController.getAIAgentId);
app.post('/api/settings/ai-agent', protect, clientScope, authController.saveAIAgentId);
app.get('/api/settings/ai-agent', protect, clientScope, authController.getAIAgentId);
app.use('/api/contacts', contactRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/bot', botRoutes);
app.use('/api/inbox', inboxRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/superadmin', superadminRoutes);
app.use('/api/photoshare', photoshareRoutes);
app.use('/api/partner', partnerRoutes);
app.use('/api/bulk', bulkMessageRoutes);

app.get('/api/health', (req, res) => {
  res.json({ success: true, data: { ok: true }, message: 'OK' });
});

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

async function bootstrap() {
  try {
    validateEnv();
    await connectDB();

    // One-time migration for existing photo templates
    try {
      const Template = require('./models/Template');
      const updated = await Template.updateMany(
        { whatsappTemplateName: 'photo', $or: [{ headerType: { $exists: false } }, { headerType: 'TEXT' }] },
        { 
          $set: { 
            headerType: 'IMAGE',
            sampleParams: [{ key: 'header_image', value: 'https://placehold.co/600x400?text=Upload+Header+Image' }]
          } 
        }
      );
      if (updated.modifiedCount > 0) {
        info(`✅ Migrated ${updated.modifiedCount} existing photo templates to IMAGE headerType.`);
      }
    } catch (migErr) {
      error('Failed to run photo template migration:', migErr);
    }

    // Force active time settings for testing-1 photoshare folder
    try {
      const PhotoshareFolder = require('./models/PhotoshareFolder');
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const future = new Date(Date.now() + 48 * 60 * 60 * 1000);
      
      const folderRes = await PhotoshareFolder.updateOne(
        { linkCode: 'event_e74f6129' },
        { 
          $set: { 
            startTime: yesterday, 
            endTime: future,
            isActive: true 
          } 
        }
      );
      if (folderRes.modifiedCount > 0) {
        info(`✅ Manually set testing-1 folder times: Start is yesterday, End is +48h.`);
      }
    } catch (foldErr) {
      error('Failed to manually update testing-1 folder times:', foldErr);
    }

    // Seed SuperAdmin from .env & remove legacy "Vijay Wiz" profile names
    try {
      const User = require('./models/User');
      const email = (process.env.SUPERADMIN_EMAIL || 'superadmin@gmail.com').toLowerCase().trim();
      const password = process.env.SUPERADMIN_PASSWORD || 'superadmin@9090';

      let sa = await User.findOne({ email }).select('+password');
      if (!sa) {
        sa = await User.create({
          name: 'Super Admin',
          email,
          password,
          role: 'superadmin',
          status: 'active',
          plan: 'enterprise',
          businessName: 'WHATS-AI Platform Owner',
        });
        info(`✅ SuperAdmin account seeded: ${email}`);
      } else {
        sa.name = 'Super Admin';
        sa.businessName = 'WHATS-AI Platform Owner';
        sa.role = 'superadmin';
        sa.status = 'active';
        sa.password = password;
        await sa.save();
        info(`✅ SuperAdmin synchronized: ${email}`);
      }

      // Clean up any remaining legacy "Vijay Wiz" records in database
      const cleaned = await User.updateMany(
        { name: /vijay wiz/i },
        { $set: { name: 'Super Admin' } }
      );
      if (cleaned.modifiedCount > 0) {
        info(`✅ Cleaned ${cleaned.modifiedCount} legacy Vijay Wiz user profiles in DB.`);
      }
    } catch (saErr) {
      error('Failed to seed/clean SuperAdmin:', saErr);
    }

    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        error(`Port ${PORT} already in use. Kill the process and retry.`);
        process.exit(1);
      } else throw e;
    });
    server.listen(PORT, () => {
      info(`Server is running on port ${PORT}`);
      initScheduler();
    });
  } catch (e) {
    error('Fatal startup error', { reason: e.message });
    process.exit(1);
  }
}

bootstrap();
