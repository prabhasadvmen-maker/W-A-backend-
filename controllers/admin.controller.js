const crypto = require('crypto');
const User = require('../models/User');
const Campaign = require('../models/Campaign');
const Message = require('../models/Message');
const AIAgent = require('../models/AIAgent');
const { success, fail } = require('../utils/apiResponse');

exports.getStats = async (req, res) => {
  try {
    const clientFilter = { parentAdmin: req.user._id, role: 'client' };
    const clients = await User.find(clientFilter).select('_id');
    const clientIds = clients.map((c) => c._id);

    const totalClients = clients.length;
    const totalCampaigns = await Campaign.countDocuments({ userId: { $in: clientIds } });
    const totalMessages = await Message.countDocuments({ userId: { $in: clientIds } });

    return success(res, {
      totalClients,
      totalCampaigns,
      totalMessages,
      limits: req.user.adminLimits || { maxClients: 20, maxMessages: 100000 },
    }, 'Admin agency stats loaded');
  } catch (e) {
    return fail(res, e.message || 'Failed to load agency stats', 500);
  }
};

exports.listClients = async (req, res) => {
  try {
    const filter = {
      role: 'client',
      $or: [
        { parentAdmin: req.user._id },
        { parentAdmin: null, status: 'pending' },
        { parentAdmin: { $exists: false }, status: 'pending' }
      ]
    };
    const clients = await User.find(filter)
      .select('-password -refreshToken')
      .sort({ createdAt: -1 });

    const clientsWithAgents = await Promise.all(
      clients.map(async (c) => {
        const agent = await AIAgent.findOne({ userId: c._id });
        return {
          ...c.toObject(),
          aiAgentId: agent ? agent.externalAgentId : '',
        };
      })
    );

    return success(res, { clients: clientsWithAgents }, 'Clients list loaded');
  } catch (e) {
    return fail(res, e.message || 'Failed to list clients', 500);
  }
};

exports.createClient = async (req, res) => {
  try {
    // Check client limit
    const currentCount = await User.countDocuments({ parentAdmin: req.user._id, role: 'client' });
    const limit = req.user.adminLimits?.maxClients || 20;
    if (currentCount >= limit) {
      return fail(res, `Client limit reached (${limit} max). Upgrade your agency plan.`, 403);
    }

    const { name, email, password, businessName, phone, plan, status, whatsappPhoneNumberId } = req.body;
    if (!name || !email || !password) {
      return fail(res, 'Name, email and password are required', 400);
    }

    const existing = await User.findOne({ email });
    if (existing) {
      return fail(res, 'User with this email already exists', 400);
    }

    const client = await User.create({
      name,
      email,
      password,
      businessName: businessName || '',
      phone: phone || '',
      plan: plan || 'free',
      role: 'client',
      parentAdmin: req.user._id,
      isVerified: true,
      status: req.isApiSharing ? 'pending' : (status || 'pending'),
      whatsappPhoneNumberId: whatsappPhoneNumberId || '',
    });

    const clientObj = client.toObject();
    delete clientObj.password;
    return success(res, { client: clientObj }, 'Client created successfully', 201);
  } catch (e) {
    return fail(res, e.message || 'Failed to create client', 500);
  }
};

exports.updateClient = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, businessName, phone, plan, isVerified, status, aiAgentId, whatsappPhoneNumberId, whatsappAccessToken } = req.body;

    const filter = {
      _id: id,
      role: 'client',
      $or: [
        { parentAdmin: req.user._id },
        { parentAdmin: null },
        { parentAdmin: { $exists: false } }
      ]
    };
    const client = await User.findOne(filter);
    if (!client) return fail(res, 'Client not found or not accessible by you', 404);

    // If client was unassigned, claim this client for this admin agency upon edit/approval
    if (!client.parentAdmin) {
      client.parentAdmin = req.user._id;
    }

    if (name !== undefined) client.name = name;
    if (businessName !== undefined) client.businessName = businessName;
    if (phone !== undefined) client.phone = phone;
    if (plan !== undefined) client.plan = plan;
    if (isVerified !== undefined) client.isVerified = Boolean(isVerified);
    if (status !== undefined) client.status = status;
    if (whatsappPhoneNumberId !== undefined) client.whatsappPhoneNumberId = whatsappPhoneNumberId;
    if (whatsappAccessToken !== undefined && whatsappAccessToken !== '') {
      client.whatsappAccessToken = whatsappAccessToken;
    }

    await client.save();

    if (aiAgentId !== undefined) {
      const agentIdStr = String(aiAgentId).trim();
      if (agentIdStr === '') {
        await AIAgent.findOneAndDelete({ userId: id });
      } else {
        await AIAgent.findOneAndUpdate(
          { userId: id },
          { userId: id, externalAgentId: agentIdStr },
          { upsert: true, new: true }
        );
      }
    }

    const updatedClient = await User.findById(id).select('-password -refreshToken');
    const agent = await AIAgent.findOne({ userId: id });
    const resClient = {
      ...updatedClient.toObject(),
      aiAgentId: agent ? agent.externalAgentId : '',
    };

    return success(res, { client: resClient }, 'Client updated successfully');
  } catch (e) {
    return fail(res, e.message || 'Failed to update client', 500);
  }
};

exports.deleteClient = async (req, res) => {
  try {
    const { id } = req.params;
    const filter = {
      _id: id,
      role: 'client',
      $or: [
        { parentAdmin: req.user._id },
        { parentAdmin: null },
        { parentAdmin: { $exists: false } }
      ]
    };
    const client = await User.findOneAndDelete(filter);
    if (!client) return fail(res, 'Client not found or not accessible by you', 404);

    return success(res, null, 'Client deleted successfully');
  } catch (e) {
    return fail(res, e.message || 'Failed to delete client', 500);
  }
};

exports.generateClientApiSharing = async (req, res) => {
  try {
    const { id } = req.params;
    const filter = {
      _id: id,
      role: 'client',
      $or: [
        { parentAdmin: req.user._id },
        { parentAdmin: null },
        { parentAdmin: { $exists: false } }
      ]
    };
    const client = await User.findOne(filter);
    if (!client) return fail(res, 'Client not found or not accessible by you', 404);

    const apiSharingKey = 'wa_share_' + crypto.randomBytes(24).toString('hex');
    const accessToken = 'wa_token_' + crypto.randomBytes(32).toString('hex');
    const referenceKey = 'wa_ref_' + crypto.randomBytes(16).toString('hex');

    client.apiSharing = {
      isEnabled: true,
      apiSharingKey,
      accessToken,
      referenceKey,
      generatedAt: new Date(),
    };

    await client.save();

    return success(res, {
      clientId: client.email,
      apiSharingKey,
      accessToken,
      referenceKey,
      baseUrl: process.env.CLIENT_URL || 'http://localhost:5173',
    }, 'Client API Sharing credentials generated successfully');
  } catch (e) {
    return fail(res, e.message || 'Failed to generate Client API Sharing credentials', 500);
  }
};

exports.revokeClientApiSharing = async (req, res) => {
  try {
    const { id } = req.params;
    const filter = {
      _id: id,
      role: 'client',
      $or: [
        { parentAdmin: req.user._id },
        { parentAdmin: null },
        { parentAdmin: { $exists: false } }
      ]
    };
    const client = await User.findOne(filter);
    if (!client) return fail(res, 'Client not found or not accessible by you', 404);

    client.apiSharing = {
      isEnabled: false,
      apiSharingKey: '',
      accessToken: '',
      referenceKey: '',
      generatedAt: null,
    };

    await client.save();

    return success(res, null, 'Client API Sharing access revoked successfully');
  } catch (e) {
    return fail(res, e.message || 'Failed to revoke Client API Sharing credentials', 500);
  }
};

exports.generateSelfApiSharing = async (req, res) => {
  try {
    const admin = await User.findById(req.user._id);
    if (!admin) return fail(res, 'Admin not found', 404);

    const apiSharingKey = 'wa_share_' + crypto.randomBytes(24).toString('hex');
    const accessToken = 'wa_token_' + crypto.randomBytes(32).toString('hex');
    const referenceKey = 'wa_ref_' + crypto.randomBytes(16).toString('hex');

    admin.apiSharing = {
      isEnabled: true,
      apiSharingKey,
      accessToken,
      referenceKey,
      generatedAt: new Date(),
    };

    await admin.save();

    return success(res, {
      adminId: admin.email,
      apiSharingKey,
      accessToken,
      referenceKey,
      baseUrl: process.env.CLIENT_URL || 'http://localhost:5173',
    }, 'Partner API Sharing credentials generated successfully');
  } catch (e) {
    return fail(res, e.message || 'Failed to generate Partner API Sharing credentials', 500);
  }
};

exports.revokeSelfApiSharing = async (req, res) => {
  try {
    const admin = await User.findById(req.user._id);
    if (!admin) return fail(res, 'Admin not found', 404);

    admin.apiSharing = {
      isEnabled: false,
      apiSharingKey: '',
      accessToken: '',
      referenceKey: '',
      generatedAt: null,
    };

    await admin.save();

    return success(res, null, 'Partner API Sharing access revoked successfully');
  } catch (e) {
    return fail(res, e.message || 'Failed to revoke Partner API Sharing credentials', 500);
  }
};
