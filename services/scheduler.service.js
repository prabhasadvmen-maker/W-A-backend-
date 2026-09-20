const cron = require('node-cron');
const Campaign = require('../models/Campaign');
const { runCampaignSendJob } = require('../controllers/campaign.controller');
const { info, error } = require('../utils/logger');

let started = false;

async function syncAllTemplateStatuses() {
  try {
    const Template = require('../models/Template');
    const User = require('../models/User');
    const { fetchMetaTemplates } = require('./whatsapp.service');

    // Sirf wo templates jo PENDING ya PENDING_ADMIN_APPROVAL me hain
    const pendingTemplates = await Template.find({
      metaStatus: { $in: ['PENDING', 'PENDING_ADMIN_APPROVAL'] }
    }).lean();

    if (!pendingTemplates.length) return;

    // Group by userId to minimize Meta API calls
    const byUser = {};
    for (const t of pendingTemplates) {
      const uid = String(t.userId);
      if (!byUser[uid]) byUser[uid] = [];
      byUser[uid].push(t);
    }

    for (const [userId, templates] of Object.entries(byUser)) {
      try {
        const metaList = await fetchMetaTemplates(userId);
        for (const t of templates) {
          const match = metaList.find(m => m.name.toLowerCase() === t.whatsappTemplateName.toLowerCase());
          if (match && match.status !== t.metaStatus) {
            await Template.findByIdAndUpdate(t._id, { metaStatus: match.status });
            info(`[TemplateSync] "${t.whatsappTemplateName}" updated: ${t.metaStatus} → ${match.status}`);
          }
        }
      } catch (e) {
        error(`[TemplateSync] Failed for userId ${userId}: ${e.message}`);
      }
    }
  } catch (e) {
    error('[TemplateSync] Sync job failed:', e.message);
  }
}

function initScheduler() {
  if (started) return;
  started = true;

  // Campaign scheduler — har minute
  cron.schedule('* * * * *', async () => {
    const now = new Date();
    try {
      const due = await Campaign.find({
        status: 'scheduled',
        scheduledAt: { $lte: now },
      }).limit(10);

      for (const c of due) {
        await runCampaignSendJob(c._id, c.userId);
      }
    } catch (e) {
      error('Scheduler cycle failed', { reason: e.message });
    }
  });

  // Template status auto-sync — har 30 minute
  cron.schedule('*/30 * * * *', async () => {
    info('[TemplateSync] Running auto-sync...');
    await syncAllTemplateStatuses();
  });

  // Startup pe bhi ek baar chalao (1 min baad)
  setTimeout(syncAllTemplateStatuses, 60 * 1000);

  info('Campaign scheduler + Template auto-sync started');
}

module.exports = { initScheduler };
