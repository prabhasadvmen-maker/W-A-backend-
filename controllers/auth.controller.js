const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { success, fail } = require('../utils/apiResponse');
const { sendWelcomeEmail } = require('../services/email.service');
const AIAgent = require('../models/AIAgent');

const ACCESS_EXPIRES = '12h';
const REFRESH_EXPIRES = '7d';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

function signAccess(userId, isApiSharing = false) {
  return jwt.sign({ id: userId, isApiSharing }, process.env.JWT_SECRET, { expiresIn: ACCESS_EXPIRES });
}

function signRefresh(userId) {
  return jwt.sign({ id: userId }, process.env.JWT_REFRESH_SECRET, { expiresIn: REFRESH_EXPIRES });
}

function setRefreshCookie(res, token) {
  res.cookie('refreshToken', token, {
    httpOnly: true,
    maxAge: COOKIE_MAX_AGE,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });
}

function sanitizeUser(userDoc) {
  const u = userDoc.toObject ? userDoc.toObject() : { ...userDoc };
  delete u.password;
  delete u.refreshToken;
  delete u.whatsappAccessToken;
  return u;
}

exports.register = async (req, res) => {
  try {
    const { name, email, password, businessName, phone } = req.body;
    if (!name || !email || !password) {
      return fail(res, 'Name, email and password are required');
    }
    const exists = await User.findOne({ email: email.toLowerCase() });
    if (exists) return fail(res, 'Email already registered');

    const user = await User.create({
      name,
      email: email.toLowerCase(),
      password,
      businessName: businessName || '',
      phone: phone || '',
      role: 'client',
      status: 'pending',
    });

    await sendWelcomeEmail(user.email, user.name).catch(() => {});

    return success(
      res,
      { user: sanitizeUser(user), isPending: true },
      'Registration successful! Your account is pending approval from the Reseller Agency / Admin.',
      201
    );
  } catch (e) {
    return fail(res, e.message || 'Registration failed', 500);
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password, expectedRole } = req.body;
    if (!email || !password) return fail(res, 'Email and password required');

    let user = await User.findOne({ email: email.toLowerCase().trim() }).select('+password');

    if (!user || !(await user.comparePassword(password))) {
      return fail(res, 'Invalid credentials', 401);
    }

    if (expectedRole && user.role !== expectedRole) {
      if (user.role === 'superadmin') {
        // SuperAdmin can log in from any portal
      } else {
        if (expectedRole === 'superadmin') {
          return fail(res, 'Access Denied: Restricted to Super Admin only.', 403);
        }
        if (expectedRole === 'admin') {
          return fail(res, 'Access Denied: Restricted to Agency Administrators only.', 403);
        }
        if (expectedRole === 'client') {
          return fail(res, 'Access Denied: Please log in using your respective Agency Admin login portal.', 403);
        }
        return fail(res, `Access Denied: Account is not authorized for the ${expectedRole} portal.`, 403);
      }
    }

    if (user.role !== 'superadmin' && user.status === 'pending') {
      return fail(res, 'Your account registration is currently Pending Approval from your Reseller Agency / Admin.', 403);
    }
    if (user.role !== 'superadmin' && user.status === 'rejected') {
      return fail(res, 'Your account registration has been Rejected by your Reseller Agency / Admin.', 403);
    }

    const accessToken = signAccess(user._id);
    const refreshToken = signRefresh(user._id);
    user.refreshToken = refreshToken;
    await user.save();

    setRefreshCookie(res, refreshToken);


    const u = sanitizeUser(user);
    if (user.role === 'client') {
      const agent = await AIAgent.findOne({ userId: user._id });
      u.aiAgentActive = Boolean(process.env.GROQ_API_KEY || (agent && agent.externalAgentId));
    } else {
      u.aiAgentActive = true;
    }

    return success(res, { user: u, accessToken }, 'Logged in');
  } catch (e) {
    return fail(res, e.message || 'Login failed', 500);
  }
};

exports.logout = async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user._id, { refreshToken: '' });
    res.clearCookie('refreshToken', { path: '/' });
    return success(res, null, 'Logged out');
  } catch (e) {
    return fail(res, e.message || 'Logout failed', 500);
  }
};

exports.me = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const u = sanitizeUser(user);
    if (user.role === 'client') {
      const agent = await AIAgent.findOne({ userId: user._id });
      u.aiAgentActive = Boolean(process.env.GROQ_API_KEY || (agent && agent.externalAgentId));
    } else {
      u.aiAgentActive = true;
    }
    return success(res, { user: u }, 'Profile');
  } catch (e) {
    return fail(res, e.message || 'Failed to load user', 500);
  }
};

exports.refresh = async (req, res) => {
  try {
    const token = req.cookies?.refreshToken;
    if (!token) return fail(res, 'No refresh token', 401);

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    } catch {
      return fail(res, 'Invalid refresh token', 401);
    }

    const user = await User.findById(decoded.id).select('+refreshToken');
    if (!user || user.refreshToken !== token) {
      return fail(res, 'Session invalid', 401);
    }

    const accessToken = signAccess(user._id);
    return success(res, { accessToken }, 'Token refreshed');
  } catch (e) {
    return fail(res, e.message || 'Refresh failed', 500);
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const { email, newPassword, adminKey } = req.body;
    if (adminKey !== 'hexstack@reset2026') return fail(res, 'Unauthorized', 401);
    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
    if (!user) return fail(res, 'User not found', 404);
    user.password = newPassword;
    await user.save();
    return success(res, null, 'Password reset done');
  } catch (e) {
    return fail(res, e.message || 'Reset failed', 500);
  }
};

exports.connectWhatsApp = async (req, res) => {
  try {
    const { whatsappPhoneNumberId, whatsappAccessToken, whatsappWabaId } = req.body;
    if (!whatsappPhoneNumberId || !whatsappAccessToken) {
      return fail(res, 'Phone Number ID and Access Token are required');
    }
    const updatePayload = {
      whatsappPhoneNumberId: String(whatsappPhoneNumberId).trim(),
      whatsappAccessToken: String(whatsappAccessToken).trim(),
    };
    // WABA ID optional hai — agar diya ho to save karo
    if (whatsappWabaId && String(whatsappWabaId).trim()) {
      updatePayload.whatsappWabaId = String(whatsappWabaId).trim();
    }
    const targetId = req.targetUserId || req.user._id;
    await User.findByIdAndUpdate(targetId, updatePayload);
    const user = await User.findById(targetId);
    return success(res, { user: sanitizeUser(user) }, 'WhatsApp connected');
  } catch (e) {
    return fail(res, e.message || 'Failed to save connection', 500);
  }
};

exports.saveAIAgentId = async (req, res) => {
  try {
    const { agentId } = req.body;
    if (agentId === undefined) {
      return fail(res, 'AI Agent ID is required');
    }
    const userId = req.targetUserId || req.user._id;
    const mapping = await AIAgent.findOneAndUpdate(
      { userId },
      { userId, externalAgentId: String(agentId).trim() },
      { upsert: true, new: true }
    );
    return success(res, { agentId: mapping.externalAgentId }, 'AI Agent ID saved');
  } catch (e) {
    return fail(res, e.message || 'Failed to save AI Agent ID', 500);
  }
};

exports.getAIAgentId = async (req, res) => {
  try {
    const userId = req.targetUserId || req.user._id;
    const mapping = await AIAgent.findOne({ userId });
    return success(res, { agentId: mapping ? mapping.externalAgentId : '' }, 'AI Agent ID');
  } catch (e) {
    return fail(res, e.message || 'Failed to get AI Agent ID', 500);
  }
};

exports.impersonate = async (req, res) => {
  try {
    const { targetUserId } = req.body;
    if (!targetUserId) return fail(res, 'Target user ID is required', 400);

    const targetUser = await User.findById(targetUserId);
    if (!targetUser) return fail(res, 'Target user not found', 404);

    if (req.user.role === 'superadmin') {
      // Superadmin can access any workspace
    } else if (req.user.role === 'admin') {
      if (String(targetUser.parentAdmin) !== String(req.user._id) || targetUser.role !== 'client') {
        return fail(res, 'Access denied: You can only access client accounts under your agency', 403);
      }
    } else {
      return fail(res, 'Access denied: Insufficient privileges', 403);
    }

    const accessToken = signAccess(targetUser._id);
    return success(res, {
      accessToken,
      user: sanitizeUser(targetUser),
    }, `Now viewing as ${targetUser.name}`);
  } catch (e) {
    return fail(res, e.message || 'Failed to switch workspace', 500);
  }
};

exports.verifyApiSharingLogin = async (req, res) => {
  try {
    const { apiSharingKey, accessToken, referenceKey } = req.body;
    if (!apiSharingKey || !accessToken || !referenceKey) {
      return fail(res, 'Missing required API Sharing credentials', 400);
    }

    const user = await User.findOne({
      'apiSharing.apiSharingKey': apiSharingKey,
      'apiSharing.accessToken': accessToken,
      'apiSharing.referenceKey': referenceKey,
      'apiSharing.isEnabled': true,
      role: { $in: ['admin', 'client'] },
    });

    if (!user) {
      return fail(res, 'Invalid or revoked API Sharing credentials', 401);
    }

    const jwtToken = signAccess(user._id, true);
    const refreshToken = signRefresh(user._id);
    user.refreshToken = refreshToken;
    await user.save();

    setRefreshCookie(res, refreshToken);

    const u = sanitizeUser(user);
    u.aiAgentActive = true;

    return success(res, { user: u, accessToken: jwtToken }, 'API Sharing login verification successful');
  } catch (e) {
    return fail(res, e.message || 'API Sharing login failed', 500);
  }
};

exports.updateProfile = async (req, res) => {
  try {
    const { name, businessName, phone, currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user._id).select('+password');
    if (!user) return fail(res, 'User not found', 404);

    if (name !== undefined && name.trim() !== '') user.name = name.trim();
    if (businessName !== undefined) user.businessName = businessName.trim();
    if (phone !== undefined) user.phone = phone.trim();

    if (newPassword && newPassword.trim() !== '') {
      if (currentPassword && !(await user.comparePassword(currentPassword))) {
        return fail(res, 'Current password is incorrect', 400);
      }
      user.password = newPassword.trim();
    }

    await user.save();
    const u = sanitizeUser(user);
    return success(res, { user: u }, 'Profile updated successfully');
  } catch (e) {
    return fail(res, e.message || 'Failed to update profile', 500);
  }
};

