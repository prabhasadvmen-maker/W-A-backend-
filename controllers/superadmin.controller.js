const User = require('../models/User');
const Campaign = require('../models/Campaign');
const Message = require('../models/Message');
const AIAgent = require('../models/AIAgent');
const { success, fail } = require('../utils/apiResponse');

exports.getStats = async (req, res) => {
  try {
    const filterAllExceptSuper = { role: { $ne: 'superadmin' } };
    const totalUsers = await User.countDocuments(filterAllExceptSuper);
    const pendingUsers = await User.countDocuments({ status: 'pending', role: { $ne: 'superadmin' } });
    const activeUsers = await User.countDocuments({ status: 'active', role: { $ne: 'superadmin' } });
    const rejectedUsers = await User.countDocuments({ status: 'rejected', role: { $ne: 'superadmin' } });
    const adminCount = await User.countDocuments({ role: 'admin' });
    const clientCount = await User.countDocuments({ role: 'client' });
    const totalCampaigns = await Campaign.countDocuments({});
    const totalMessages = await Message.countDocuments({});

    return success(res, {
      totalUsers,
      pendingUsers,
      activeUsers,
      rejectedUsers,
      adminCount,
      clientCount,
      totalCampaigns,
      totalMessages,
    }, 'Superadmin stats loaded');
  } catch (e) {
    return fail(res, e.message || 'Failed to load superadmin stats', 500);
  }
};

exports.listUsers = async (req, res) => {
  try {
    const users = await User.find({ role: { $ne: 'superadmin' } })
      .select('-password -refreshToken')
      .sort({ status: -1, createdAt: -1 });

    const usersWithAgents = await Promise.all(
      users.map(async (u) => {
        const agent = await AIAgent.findOne({ userId: u._id });
        return {
          ...u.toObject(),
          aiAgentId: agent ? agent.externalAgentId : '',
        };
      })
    );

    return success(res, { users: usersWithAgents }, 'All registered users loaded');
  } catch (e) {
    return fail(res, e.message || 'Failed to list users', 500);
  }
};

exports.updateUserStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['active', 'pending', 'rejected'].includes(status)) {
      return fail(res, 'Invalid status', 400);
    }

    const user = await User.findById(id);
    if (!user) return fail(res, 'User not found', 404);

    user.status = status;
    if (status === 'active') {
      user.isVerified = true;
    }
    await user.save();

    const updatedUser = user.toObject();
    delete updatedUser.password;

    return success(res, { user: updatedUser }, `User status updated to ${status}`);
  } catch (e) {
    return fail(res, e.message || 'Failed to update user status', 500);
  }
};

exports.updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, role, plan, status, businessName, phone, whatsappPhoneNumberId } = req.body;

    const user = await User.findById(id);
    if (!user) return fail(res, 'User not found', 404);

    if (name !== undefined) user.name = name;
    if (email !== undefined) user.email = email.toLowerCase().trim();
    if (role !== undefined && ['admin', 'client'].includes(role)) user.role = role;
    if (plan !== undefined) user.plan = plan;
    if (status !== undefined) user.status = status;
    if (businessName !== undefined) user.businessName = businessName;
    if (phone !== undefined) user.phone = phone;
    if (whatsappPhoneNumberId !== undefined) user.whatsappPhoneNumberId = whatsappPhoneNumberId;

    await user.save();

    const updatedUser = user.toObject();
    delete updatedUser.password;

    return success(res, { user: updatedUser }, 'User updated successfully');
  } catch (e) {
    return fail(res, e.message || 'Failed to update user', 500);
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findByIdAndDelete(id);
    if (!user) return fail(res, 'User not found', 404);

    return success(res, null, 'User deleted successfully');
  } catch (e) {
    return fail(res, e.message || 'Failed to delete user', 500);
  }
};
