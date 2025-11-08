const { loadEnvFile } = require('./lib/crypto');
const { checkMessages } = require('./lib/message-box');

async function main() {
  try {
    loadEnvFile();
    const accountId = process.env.MESSAGE_BOX_OWNER_ACCOUNT_ID;
    if (!accountId) {
      throw new Error('MESSAGE_BOX_OWNER_ACCOUNT_ID is required.');
    }

    const args = process.argv.slice(2);
    const startSequence = args[0] ? parseInt(args[0]) : 2;
    const endSequence = args[1] ? parseInt(args[1]) : undefined;

    if (isNaN(startSequence) || startSequence < 1) {
      console.error('\n✗ Error: Start sequence must be a positive number');
      console.error(
        '✓ Usage: node check-messages.js [start-sequence] [end-sequence]'
      );
      console.error('✓ Examples:');
      console.error(
        '  node check-messages.js              # Get all messages from sequence 2 onwards'
      );
      console.error(
        '  node check-messages.js 5            # Get all messages from sequence 5'
      );
      console.error(
        '  node check-messages.js 5 10         # Get messages from sequence 5 to 10\n'
      );
      process.exit(1);
    }

    if (
      endSequence !== undefined &&
      (isNaN(endSequence) || endSequence < startSequence)
    ) {
      console.error(
        '\n✗ Error: End sequence must be a number >= start sequence'
      );
      process.exit(1);
    }

    console.log(`⚙ Checking messages for account ${accountId}`);

    const messages = await checkMessages(
      process.env.RSA_DATA_DIR,
      accountId,
      startSequence,
      endSequence
    );

    if (messages.length === 0) {
      console.log('✓ No messages found in the specified range\n');
    } else {
      console.log(`✓ Found ${messages.length} message(s):\n`);
      messages.forEach(message => console.log(`📥 ${message}`));
      console.log();
    }

    process.exit(0);
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
