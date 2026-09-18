require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI;

async function cleanDB() {
  await mongoose.connect(MONGO_URI);
  console.log('✅ Connected to MongoDB');

  const db = mongoose.connection.db;

  // Delete all users EXCEPT superadmin
  const usersResult = await db.collection('users').deleteMany({ role: { $ne: 'superadmin' } });
  console.log(`🗑️  Users deleted: ${usersResult.deletedCount}`);

  // Clean all other collections completely
  const collections = ['templates', 'campaigns', 'messages', 'contacts', 'contactgroups', 'conversations', 'botflows', 'analytics', 'aiagents'];

  for (const col of collections) {
    try {
      const result = await db.collection(col).deleteMany({});
      console.log(`🗑️  ${col}: ${result.deletedCount} deleted`);
    } catch (e) {
      console.log(`⚠️  ${col}: skipped (${e.message})`);
    }
  }

  console.log('\n✅ Database cleaned! Superadmin account preserved.');
  await mongoose.disconnect();
  process.exit(0);
}

cleanDB().catch(e => {
  console.error('❌ Error:', e.message);
  process.exit(1);
});
