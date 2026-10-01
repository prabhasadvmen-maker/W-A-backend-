const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const clientScope = require('../middleware/clientScope.middleware');
const { sendBulkMessage, getBulkHistory } = require('../controllers/bulkMessage.controller');
const { mediaUpload } = require('../middleware/upload.middleware');

router.post('/send', protect, clientScope, mediaUpload.single('file'), sendBulkMessage);
router.get('/history', protect, clientScope, getBulkHistory);

module.exports = router;
