const express = require('express');
const router = express.Router();
const { protect, authorizeRoles } = require('../middleware/auth.middleware');
const adminCtrl = require('../controllers/admin.controller');

// All routes require authentication and admin role
router.use(protect, authorizeRoles('admin'));

router.get('/stats', adminCtrl.getStats);
router.get('/clients', adminCtrl.listClients);
router.post('/clients', adminCtrl.createClient);
router.put('/clients/:id', adminCtrl.updateClient);
router.delete('/clients/:id', adminCtrl.deleteClient);
router.post('/clients/:id/api-sharing', adminCtrl.generateClientApiSharing);
router.delete('/clients/:id/api-sharing', adminCtrl.revokeClientApiSharing);
router.post('/self-api-sharing', adminCtrl.generateSelfApiSharing);
router.delete('/self-api-sharing', adminCtrl.revokeSelfApiSharing);

module.exports = router;
