const { initializeClient } = require('./lib/hedera');
const { loadEnvFile } = require('./lib/crypto');
const { sendMessage } = require('./lib/message-box');

let client = null;

async function main() {
  try {
    loadEnvFile();
    client = initializeClient();

    const args = process.argv.slice(2);
    const cborIndex = args.indexOf('--cbor');
    const useCBOR = cborIndex !== -1;
    if (useCBOR) args.splice(cborIndex, 1);

    if (args.length < 2) {
      console.error(
        '\n✗ Usage: node send-message.js <account-id> <message> [--cbor]'
      );
      console.error('✓ Examples:');
      console.error('  node send-message.js 0.0.1234 "Hello!"');
      console.error('  node send-message.js 0.0.1234 "Hello!" --cbor\n');
      process.exit(1);
    }

    const recipientAccountId = args[0];
    const message = args.slice(1).join(' ');
    const format = useCBOR ? 'CBOR' : 'JSON';
    console.log(
      `⚙ Sending message:\n  - Recipient: ${recipientAccountId}\n  - Message before encryption: "${message}"\n  - Format: ${format}`
    );
    await sendMessage(client, recipientAccountId, message, { useCBOR });
    client.close();
    process.exit(0);
  } catch (error) {
    console.error('\n✗ Error:', error.message);
    if (client) client.close();
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  console.log('\n\n⚙ Shutting down...');
  if (client) client.close();
  process.exit(0);
});

main();
