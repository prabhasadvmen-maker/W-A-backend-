const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const clientScope = require('../middleware/clientScope.middleware');
const { sendBulkMessage, getBulkHistory } = require('../controllers/bulkMessage.controller');

router.post('/send', protect, clientScope, sendBulkMessage);
router.get('/history', protect, clientScope, getBulkHistory);

module.exports = router;
