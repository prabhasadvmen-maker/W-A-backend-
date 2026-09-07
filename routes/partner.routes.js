const express = require('express');
const router = express.Router();
const User = require('../models/User');
const partnerCtrl = require('../controllers/partner.controller');

// Partner key protection middleware
const partnerProtect = async (req, res, next) => {
  try {
    const partnerKey = req.headers['x-partner-key'];
    if (!partnerKey) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Missing x-partner-key header' });
    }

    // Find active Admin with this sharing key
    const admin = await User.findOne({
      'apiSharing.apiSharingKey': partnerKey,
      'apiSharing.isEnabled': true,
      role: 'admin'
    });

    if (!admin) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Invalid or inactive Partner Key' });
    }

    req.partnerAdmin = admin;
    next();
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

router.use(partnerProtect);

router.post('/sync-client', partnerCtrl.partnerSyncClient);
router.post('/request-template', partnerCtrl.partnerRequestTemplate);
router.get('/template-status', partnerCtrl.partnerGetTemplateStatus);
router.get('/client-status', partnerCtrl.partnerGetClientStatus);

module.exports = router;
