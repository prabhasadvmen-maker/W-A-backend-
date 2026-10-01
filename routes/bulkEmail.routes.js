const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const clientScope = require('../middleware/clientScope.middleware');
const { sendBulkEmail, getBulkEmailHistory } = require('../controllers/bulkEmail.controller');

router.post('/send', protect, clientScope, sendBulkEmail);
router.get('/history', protect, clientScope, getBulkEmailHistory);

module.exports = router;
