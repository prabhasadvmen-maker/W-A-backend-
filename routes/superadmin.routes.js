const express = require('express');
const router = express.Router();
const { protect, authorizeRoles } = require('../middleware/auth.middleware');
const superadminCtrl = require('../controllers/superadmin.controller');

// All routes require authentication and superadmin role
router.use(protect, authorizeRoles('superadmin'));

router.get('/stats', superadminCtrl.getStats);
router.get('/users', superadminCtrl.listUsers);
router.patch('/users/:id/status', superadminCtrl.updateUserStatus);
router.patch('/users/:id', superadminCtrl.updateUser);
router.delete('/users/:id', superadminCtrl.deleteUser);

// Template Management
router.get('/templates', superadminCtrl.listAllTemplates);
router.delete('/templates/:templateId', superadminCtrl.deleteTemplate);
router.post('/templates/:templateId/refresh-status', superadminCtrl.refreshTemplateStatus);

module.exports = router;
