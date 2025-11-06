const { loadEnvFile } = require('./lib/common');
const { pollMessages } = require('./lib/message-box');

async function main() {
  try {
    loadEnvFile();
    const accountId = process.env.HEDERA_ACCOUNT_ID;
    console.log(`⚙ Listening for messages for account ${accountId}`);
    console.log('✓ Polling every 3 seconds. Press Ctrl+C to exit\n');
    while (true) {
      const messages = await pollMessages(process.env.DATA_DIR, accountId);
      if (messages.length > 0) {
        console.log(`${messages.length} new message(s) received`);
        messages.forEach(message => console.log(`📥 ${message}`));
      }
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  } catch (error) {
    console.error('\n✗ Error:', error.message);
    process.exit(1);
  }
}

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log('\n\n⚙ Shutting down...');
  process.exit(0);
});

main();
