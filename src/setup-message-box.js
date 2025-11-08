const { initializeClient } = require('./lib/hedera');
const { loadEnvFile } = require('./lib/crypto');
const { setupMessageBox } = require('./lib/message-box');

let client = null;

async function main() {
  try {
    loadEnvFile();
    const accountId = process.env.MESSAGE_BOX_OWNER_ACCOUNT_ID;
    if (!accountId) {
      throw new Error('MESSAGE_BOX_OWNER_ACCOUNT_ID is required.');
    }
    client = initializeClient();
    console.log(`⚙ Setup message box for account ${accountId}`);
    await setupMessageBox(client, process.env.RSA_DATA_DIR, accountId);
    client.close();
    process.exit(0);
  } catch (error) {
    console.error('\n✗ Error:', error.message);
    if (client) client.close();
    process.exit(1);
  }
}

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log('\n\n⚙ Shutting down...');
  if (client) client.close();
  process.exit(0);
});

main();
