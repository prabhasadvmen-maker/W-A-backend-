const mongoose = require('mongoose');

const clientScope = (req, res, next) => {
  req.targetUserId = req.user ? req.user._id : null;

  if (
    req.user &&
    req.user.role === 'admin' &&
    req.headers['x-client-id']
  ) {
    const clientId = req.headers['x-client-id'];
    if (mongoose.Types.ObjectId.isValid(clientId)) {
      req.targetUserId = clientId;
    }
  }

  next();
};

module.exports = clientScope;
