const mongoose = require('mongoose');

const conversationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    customerPhone: { type: String, required: true, trim: true },
    customerName: { type: String, default: '' },
    assignedAgent: { type: String, default: '' },
    status: {
      type: String,
      enum: ['open', 'resolved', 'pending'],
      default: 'open',
    },
    lastMessage: { type: String, default: '' },
    lastMessageAt: { type: Date, default: Date.now },
    unreadCount: { type: Number, default: 0 },
    botContext: {
      flowId: { type: mongoose.Schema.Types.ObjectId, ref: 'BotFlow', default: null },
      currentNodeId: { type: String, default: '' },
      awaitingMenu: { type: Boolean, default: false },
    },
    isAIPaused: { type: Boolean, default: false },
    aiChatHistory: [
      {
        role: { type: String, enum: ['user', 'assistant'] },
        content: { type: String },
      },
    ],
    activePhotoshareFolderId: { type: mongoose.Schema.Types.ObjectId, ref: 'PhotoshareFolder', default: null },
  },
  { timestamps: true }
);

conversationSchema.index({ userId: 1, customerPhone: 1 }, { unique: true });

module.exports = mongoose.model('Conversation', conversationSchema);
