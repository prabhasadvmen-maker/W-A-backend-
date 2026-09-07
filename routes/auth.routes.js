const express = require('express');
const router = express.Router();
const auth = require('../controllers/auth.controller');
const { protect } = require('../middleware/auth.middleware');

router.post('/register', auth.register);
router.post('/login', auth.login);
router.post('/refresh', auth.refresh);
router.post('/reset-password', auth.resetPassword);
router.post('/logout', protect, auth.logout);
router.get('/me', protect, auth.me);
router.put('/profile', protect, auth.updateProfile);
router.post('/impersonate', protect, auth.impersonate);
router.post('/api-sharing-login', auth.verifyApiSharingLogin);

module.exports = router;
