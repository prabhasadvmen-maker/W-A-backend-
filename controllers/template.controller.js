const Template = require('../models/Template');
const User = require('../models/User');
const { success, fail } = require('../utils/apiResponse');
const {
  fetchMetaTemplates,
  verifyMetaTemplate,
  createMetaTemplate,
  refreshTemplateStatus,
} = require('../services/whatsapp.service');

// ─── CLIENT: apni assigned templates list ────────────────────────────────────
exports.listTemplates = async (req, res) => {
  try {
    // Client: sirf wo templates jo uske liye assign hain (assignedTo = client._id)
    const templates = await Template.find({ assignedTo: req.targetUserId }).sort({ createdAt: -1 });
    return success(res, { templates }, 'Templates');
  } catch (e) {
    return fail(res, e.message || 'Failed to list templates', 500);
  }
};

exports.getTemplate = async (req, res) => {
  try {
    const template = await Template.findOne({
      _id: req.params.id,
      assignedTo: req.targetUserId,
    });
    if (!template) return fail(res, 'Template not found', 404);
    return success(res, { template }, 'Template');
  } catch (e) {
    return fail(res, e.message || 'Failed to load template', 500);
  }
};

exports.createTemplate = async (req, res) => {
  try {
    const { name, category, language, bodyText, headerText, footerText, variables } = req.body;
    if (!name || !bodyText) {
      return fail(res, 'Template name and body text are required', 400);
    }

    const cleanName = String(name).toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');

    // Check if template exists for client
    const existing = await Template.findOne({
      assignedTo: req.targetUserId,
      whatsappTemplateName: cleanName
    });
    if (existing) {
      return fail(res, 'Template with this name already exists', 400);
    }

    // Client templates will be owned by their parent Admin and assigned to this client
    const template = await Template.create({
      userId: req.user.parentAdmin || req.user._id, // Owner is parent admin (who holds the Meta API keys)
      assignedTo: req.targetUserId,
      createdByAdmin: null, // null means client requested it
      name: name.trim(),
      whatsappTemplateName: cleanName,
      languageCode: language || 'en',
      category: category || 'MARKETING',
      bodyPreview: bodyText,
      headerText: headerText || '',
      footerText: footerText || '',
      sampleParams: (variables || []).map((v, i) => ({
        key: String(i + 1),
        value: v.value || v.key || ''
      })),
      metaStatus: 'PENDING_ADMIN_APPROVAL'
    });

    return success(res, { template }, 'Template request submitted to Admin successfully', 201);
  } catch (e) {
    return fail(res, e.message || 'Failed to submit template request', 500);
  }
};
exports.updateTemplate = async (req, res) => {
  try {
    const template = await Template.findOne({ _id: req.params.id, assignedTo: req.targetUserId });
    if (!template) return fail(res, 'Template not found', 404);

    if (req.body.sampleParams) {
      template.sampleParams = req.body.sampleParams;
      await template.save();
      return success(res, { template }, 'Template variables updated successfully');
    }
    
    return fail(res, 'You can only edit variables of a template.', 400);
  } catch(e) {
    return fail(res, e.message || 'Failed to update template variables', 500);
  }
};
exports.deleteTemplate = async (req, res) => {
  try {
    const t = await Template.findOneAndDelete({ 
      _id: req.params.id, 
      assignedTo: req.targetUserId 
    });
    if (!t) return fail(res, 'Template not found or not yours to delete', 404);
    return success(res, null, 'Template deleted successfully');
  } catch (e) {
    return fail(res, e.message || 'Delete failed', 500);
  }
};

// ─── ADMIN: client ke liye template create/manage ────────────────────────────

/**
 * GET /api/templates/admin/clients/:clientId
 * Admin kisi client ki saari templates dekhe
 */
exports.adminListClientTemplates = async (req, res) => {
  try {
    const { clientId } = req.params;
    // Verify: client admin ke under ho
    const client = await User.findOne({
      _id: clientId,
      role: 'client',
      parentAdmin: req.user._id,
    });
    if (!client) return fail(res, 'Client not found or not accessible', 404);

    const templates = await Template.find({ assignedTo: clientId }).sort({ createdAt: -1 });
    return success(res, { templates }, `Templates for ${client.name}`);
  } catch (e) {
    return fail(res, e.message || 'Failed to list client templates', 500);
  }
};

/**
 * POST /api/templates/admin/clients/:clientId/create-on-meta
 * Admin ek naya template Meta par CREATE kare aur client ko assign kare
 * Body: { name, category, language, bodyText, headerText, footerText, variables[], wabaId? }
 */
exports.adminCreateTemplateOnMeta = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { name, category, language, bodyText, headerText, footerText, variables, wabaId } = req.body;

    if (!name || !bodyText) {
      return fail(res, 'Template name and body text are required', 400);
    }

    // Client verify
    const client = await User.findOne({ _id: clientId, role: 'client' });
    if (!client) return fail(res, 'Client not found', 404);

    // Agar admin ne custom wabaId diya hai to usse admin user par temporarily set karo
    // (ya directly use karo service mein)
    let effectiveAdminId = req.user._id;
    if (wabaId && wabaId.trim()) {
      // Temporarily update admin's wabaId for this call
      await User.findByIdAndUpdate(req.user._id, { whatsappWabaId: wabaId.trim() });
    }

    // Template name clean karo (Meta rules: lowercase, underscore, no spaces)
    const cleanName = String(name).toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');

    // ─── Variable Normalization ───
    // Meta requires header and body variables to start from {{1}} independently.
    let finalHeaderText = headerText ? headerText.trim() : '';
    let finalBodyText = bodyText ? bodyText.trim() : '';
    const userVariables = variables || [];
    let varIndex = 0;
    const headerParams = [];
    const bodyParams = [];

    if (finalHeaderText) {
      const headerMatches = finalHeaderText.match(/\{\{(\d+)\}\}/g);
      if (headerMatches) {
        finalHeaderText = finalHeaderText.replace(/\{\{(\d+)\}\}/g, '{{1}}');
        headerParams.push(userVariables[varIndex]?.value || 'header_sample');
        varIndex += headerMatches.length;
      }
    }

    if (finalBodyText) {
      const bodyMatches = finalBodyText.match(/\{\{(\d+)\}\}/g);
      if (bodyMatches) {
        const uniqueNums = [...new Set(bodyMatches.map(m => parseInt(m.match(/\d+/)[0])))].sort((a,b)=>a-b);
        uniqueNums.forEach((num, index) => {
          const metaNum = index + 1;
          const regex = new RegExp(`\\{\\{${num}\\}\\}`, 'g');
          finalBodyText = finalBodyText.replace(regex, `{{${metaNum}}}`);
          bodyParams.push(userVariables[varIndex]?.value || `sample_${metaNum}`);
          varIndex++;
        });
      }
    }

    // Meta par create karo
    const metaResponse = await createMetaTemplate(effectiveAdminId, {
      name: cleanName,
      category: category || 'MARKETING',
      language: language || 'en',
      bodyText: finalBodyText,
      headerText: finalHeaderText,
      footerText: footerText || '',
      headerVariables: headerParams,
      bodyVariables: bodyParams,
    });

    // Display name: clean name ko readable banao
    const displayName = name.trim();

    // DB mein save karo — client ke liye assign
    const template = await Template.create({
      userId: req.user._id, // Admin ka ID as owner
      assignedTo: clientId,
      createdByAdmin: req.user._id,
      name: displayName,
      whatsappTemplateName: cleanName,
      languageCode: language || 'en',
      category: category || 'MARKETING',
      bodyPreview: finalBodyText,
      headerText: finalHeaderText,
      footerText: footerText || '',
      sampleParams: (variables || []).map((v, i) => ({
        key: String(i + 1),
        value: v.value || v.key || '',
      })),
      metaStatus: metaResponse.status || 'PENDING',
      metaTemplateId: metaResponse.id || '',
    });

    return success(
      res,
      { template, metaStatus: metaResponse.status },
      `Template "${displayName}" created on Meta — Status: ${metaResponse.status || 'PENDING'}`
    , 201);
  } catch (e) {
    const status = e.statusCode || 500;
    const msg = e.response?.data?.error?.message || e.message || 'Failed to create template on Meta';
    return fail(res, msg, status);
  }
};

/**
 * POST /api/templates/admin/clients/:clientId/assign
 * Admin existing local template ko client ke liye assign kare
 * Body: { name, whatsappTemplateName, languageCode, bodyPreview, sampleParams }
 */
exports.adminAssignTemplate = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { name, whatsappTemplateName, languageCode, bodyPreview, sampleParams, category } = req.body;

    if (!name || !whatsappTemplateName) {
      return fail(res, 'Name and WhatsApp template name are required', 400);
    }

    const client = await User.findOne({ _id: clientId, role: 'client' });
    if (!client) return fail(res, 'Client not found', 404);

    // Meta se verify karo status
    let metaStatus = 'DRAFT';
    let headerType = 'TEXT';
    try {
      const verification = await verifyMetaTemplate(req.user._id, whatsappTemplateName);
      if (verification.found) {
        metaStatus = verification.status;
        const headerComp = (verification.template?.components || []).find((c) => c.type === 'HEADER');
        if (headerComp?.format === 'IMAGE') headerType = 'IMAGE';
      }
    } catch { /* ignore — status draft rahega */ }

    const finalSampleParams = [...(Array.isArray(sampleParams) ? sampleParams : [])];
    if (headerType === 'IMAGE' && !finalSampleParams.find(p => p.key === 'header_image')) {
      finalSampleParams.unshift({ key: 'header_image', value: 'https://placehold.co/600x400?text=Upload+Header+Image' });
    }

    const template = await Template.create({
      userId: req.user._id,
      assignedTo: clientId,
      createdByAdmin: req.user._id,
      name,
      whatsappTemplateName,
      languageCode: languageCode || 'en',
      category: category || 'MARKETING',
      bodyPreview: bodyPreview || '',
      headerType,
      sampleParams: finalSampleParams,
      metaStatus,
    });

    return success(res, { template }, 'Template assigned to client', 201);
  } catch (e) {
    return fail(res, e.message || 'Failed to assign template', 500);
  }
};

/**
 * PATCH /api/templates/admin/:templateId
 * Admin kisi bhi template ko edit kare
 */
exports.adminUpdateTemplate = async (req, res) => {
  try {
    const allowed = ['name', 'whatsappTemplateName', 'languageCode', 'bodyPreview', 'sampleParams', 'category', 'headerText', 'footerText'];
    const update = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) update[k] = req.body[k];
    }
    const template = await Template.findOneAndUpdate(
      { _id: req.params.templateId, createdByAdmin: req.user._id },
      update,
      { new: true }
    );
    if (!template) return fail(res, 'Template not found or not yours to edit', 404);
    return success(res, { template }, 'Template updated');
  } catch (e) {
    return fail(res, e.message || 'Update failed', 500);
  }
};

/**
 * DELETE /api/templates/admin/:templateId
 * Admin template delete kare
 */
exports.adminDeleteTemplate = async (req, res) => {
  try {
    const template = await Template.findById(req.params.templateId);
    if (!template) return fail(res, 'Template not found', 404);

    // Authorization check: Must be owner admin
    if (String(template.userId) !== String(req.user._id)) {
      return fail(res, 'Template is not yours to delete', 403);
    }

    await Template.findByIdAndDelete(req.params.templateId);
    return success(res, null, 'Template deleted successfully');
  } catch (e) {
    return fail(res, e.message || 'Delete failed', 500);
  }
};

/**
 * POST /api/templates/admin/:templateId/refresh-status
 * Meta se latest status pull karo aur DB update karo
 */
exports.adminRefreshStatus = async (req, res) => {
  try {
    const template = await Template.findOne({ _id: req.params.templateId });
    if (!template) return fail(res, 'Template not found', 404);

    const result = await refreshTemplateStatus(req.user._id, template.whatsappTemplateName);
    if (result.found) {
      template.metaStatus = result.status;
      await template.save();
    }
    return success(res, { template, metaResult: result }, `Status: ${result.found ? result.status : 'Not found on Meta'}`);
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message || 'Status refresh failed';
    return fail(res, msg, 500);
  }
};

/**
 * POST /api/templates/admin/clients/:clientId/refresh-all-status
 * Client ke saare templates ka Meta status refresh karo
 */
exports.adminRefreshAllStatus = async (req, res) => {
  try {
    const { clientId } = req.params;
    const templates = await Template.find({ assignedTo: clientId });
    const metaTemplates = await fetchMetaTemplates(req.user._id);

    let updated = 0;
    for (const t of templates) {
      const match = metaTemplates.find(
        (m) => m.name.toLowerCase() === t.whatsappTemplateName.toLowerCase()
      );
      if (match && match.status !== t.metaStatus) {
        t.metaStatus = match.status;
        await t.save();
        updated++;
      }
    }
    return success(res, { updated, total: templates.length }, `Refreshed ${updated} template statuses`);
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message || 'Refresh failed';
    return fail(res, msg, 500);
  }
};

// ─── META GRAPH API (Admin global use) ───────────────────────────────────────

exports.metaList = async (req, res) => {
  try {
    const templates = await fetchMetaTemplates(req.user._id);
    return success(res, { templates }, `Fetched ${templates.length} templates from Meta`);
  } catch (e) {
    const status = e.statusCode || 500;
    const msg = e.response?.data?.error?.message || e.message || 'Failed to fetch from Meta';
    return fail(res, msg, status);
  }
};

exports.metaVerify = async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return fail(res, 'Template name is required', 400);
    const result = await verifyMetaTemplate(req.user._id, name.trim());
    return success(res, result, result.found ? `Template "${name}" found on Meta` : `Template "${name}" not found on Meta`);
  } catch (e) {
    const status = e.statusCode || 500;
    const msg = e.response?.data?.error?.message || e.message || 'Verification failed';
    return fail(res, msg, status);
  }
};

exports.metaSync = async (req, res) => {
  try {
    const metaTemplates = await fetchMetaTemplates(req.user._id);
    const approved = metaTemplates.filter((t) => t.status === 'APPROVED');
    let created = 0, updated = 0;
    for (const mt of approved) {
      const headerComp = (mt.components || []).find((c) => c.type === 'HEADER');
      const hasImageHeader = headerComp?.format === 'IMAGE';
      const headerText = headerComp?.type === 'HEADER' && headerComp?.format === 'TEXT' ? headerComp.text : '';

      const sampleParams = [];
      if (hasImageHeader) {
        sampleParams.push({ key: 'header_image', value: 'https://placehold.co/600x400?text=Upload+Header+Image' });
      }

      const bodyComp = (mt.components || []).find((c) => c.type === 'BODY');
      const bodyText = bodyComp?.text || '';
      const varMatches = bodyText.match(/\{\{(\d+)\}\}/g) || [];
      const uniqueVars = [...new Set(varMatches)];
      uniqueVars.forEach((v) => {
        const num = v.replace(/[{}]/g, '');
        sampleParams.push({ key: num, value: `sample_${num}` });
      });

      const displayName = mt.name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      const existing = await Template.findOne({ userId: req.user._id, whatsappTemplateName: mt.name, assignedTo: null });
      if (existing) {
        existing.languageCode = mt.language || 'en';
        existing.bodyPreview = bodyText || existing.bodyPreview;
        existing.headerText = headerText || existing.headerText;
        existing.headerType = hasImageHeader ? 'IMAGE' : 'TEXT';
        existing.metaStatus = mt.status;
        existing.sampleParams = sampleParams;
        await existing.save();
        updated++;
      } else {
        await Template.create({
          userId: req.user._id,
          assignedTo: null,
          name: displayName,
          whatsappTemplateName: mt.name,
          languageCode: mt.language || 'en',
          bodyPreview: bodyText,
          headerText,
          headerType: hasImageHeader ? 'IMAGE' : 'TEXT',
          sampleParams,
          metaStatus: mt.status,
        });
        created++;
      }
    }
    return success(res, { total: approved.length, created, updated }, `Sync complete: ${created} new, ${updated} updated`);
  } catch (e) {
    const status = e.statusCode || 500;
    const msg = e.response?.data?.error?.message || e.message || 'Sync failed';
    return fail(res, msg, status);
  }
};

exports.adminApproveAndSubmit = async (req, res) => {
  try {
    const { templateId } = req.params;
    
    // Find template and ensure owner is the admin (req.user._id)
    const template = await Template.findOne({ _id: templateId, userId: req.user._id });
    if (!template) {
      return fail(res, 'Template not found or not owned by you', 404);
    }

    if (template.metaStatus !== 'PENDING_ADMIN_APPROVAL' && template.metaStatus !== 'DRAFT') {
      return fail(res, `Template is already submitted or has status ${template.metaStatus}`, 400);
    }

    // Normalize variables
    let finalHeaderText = template.headerText ? template.headerText.trim() : '';
    let finalBodyText = template.bodyPreview ? template.bodyPreview.trim() : '';
    const sampleParams = template.sampleParams || [];
    
    let varIndex = 0;
    const headerParams = [];
    const bodyParams = [];

    if (finalHeaderText) {
      const headerMatches = finalHeaderText.match(/\{\{(\d+)\}\}/g);
      if (headerMatches) {
        finalHeaderText = finalHeaderText.replace(/\{\{(\d+)\}\}/g, '{{1}}');
        headerParams.push(sampleParams[varIndex]?.value || 'header_sample');
        varIndex += headerMatches.length;
      }
    }

    if (finalBodyText) {
      const bodyMatches = finalBodyText.match(/\{\{(\d+)\}\}/g);
      if (bodyMatches) {
        const uniqueNums = [...new Set(bodyMatches.map(m => parseInt(m.match(/\d+/)[0])))].sort((a,b)=>a-b);
        uniqueNums.forEach((num, index) => {
          const metaNum = index + 1;
          const regex = new RegExp(`\\{\\{${num}\\}\\}`, 'g');
          finalBodyText = finalBodyText.replace(regex, `{{${metaNum}}}`);
          bodyParams.push(sampleParams[varIndex]?.value || `sample_${metaNum}`);
          varIndex++;
        });
      }
    }

    // Submit to Meta
    const metaResponse = await createMetaTemplate(req.user._id, {
      name: template.whatsappTemplateName,
      category: template.category || 'MARKETING',
      language: template.languageCode || 'en',
      bodyText: finalBodyText,
      headerText: finalHeaderText,
      footerText: template.footerText || '',
      headerVariables: headerParams,
      bodyVariables: bodyParams,
    });

    template.metaStatus = metaResponse.status || 'PENDING';
    template.metaTemplateId = metaResponse.id || '';
    template.bodyPreview = finalBodyText; // Update with normalized body
    template.headerText = finalHeaderText; // Update with normalized header
    await template.save();

    return success(
      res,
      { template, metaStatus: template.metaStatus },
      `Template Approved & Submitted to Meta — Status: ${template.metaStatus}`
    );
  } catch (e) {
    const status = e.statusCode || 500;
    const msg = e.response?.data?.error?.message || e.message || 'Failed to submit template to Meta';
    return fail(res, msg, status);
  }
};
