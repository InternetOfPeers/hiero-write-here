const {
  AccountId,
  AccountInfoQuery,
  TopicMessageSubmitTransaction
} = require('@hashgraph/sdk');
const {
  loadEnvFile,
  initializeClient,
  extractTopicIdFromMemo,
  getPublicKeyFromTopic,
  encryptMessage
} = require('./common');

// Hedera client setup
let client;

/**
 * Get account memo by account ID
 */
async function getAccountMemo(accountId) {
  console.log(`Fetching account memo for ${accountId}...`);

  const query = new AccountInfoQuery()
    .setAccountId(AccountId.fromString(accountId));

  const accountInfo = await query.execute(client);
  const memo = accountInfo.accountMemo;

  console.log(`✓ Account memo: "${memo}"`);
  return memo;
}

/**
 * Extract topic ID from memo (wrapper with error throwing)
 */
function extractTopicId(memo) {
  const topicId = extractTopicIdFromMemo(memo);
  if (!topicId) {
    throw new Error('Topic ID not found in account memo');
  }
  console.log(`✓ Extracted topic ID: ${topicId}`);
  return topicId;
}

/**
 * Send encrypted message to topic
 */
async function sendMessageToTopic(topicId, encryptedPayload) {
  console.log(`Sending encrypted message to topic ${topicId}...`);

  const payload = JSON.stringify({
    type: 'ENCRYPTED_MESSAGE',
    data: encryptedPayload,
    timestamp: Date.now()
  });

  const transaction = new TopicMessageSubmitTransaction({
    topicId: topicId,
    message: payload
  });

  const txResponse = await transaction.execute(client);
  const receipt = await txResponse.getReceipt(client);

  console.log('✓ Message sent successfully');
  console.log(`  Status: ${receipt.status.toString()}`);
  return receipt;
}

/**
 * Main application flow
 */
async function main() {
  try {
    // Check command line arguments
    if (process.argv.length < 4) {
      console.error('\n❌ Usage: node send.js <account-id> <message>');
      console.error('Example: node send.js 0.0.1234 "Hello, World!"\n');
      process.exit(1);
    }

    const targetAccountId = process.argv[2];
    const message = process.argv.slice(3).join(' '); // Join all remaining args as message

    console.log('=== Write Here - Send Encrypted Message ===\n');
    console.log(`Target Account: ${targetAccountId}`);
    console.log(`Message: "${message}"\n`);

    // Step 1: Load environment variables
    loadEnvFile();

    // Step 2: Initialize Hedera client
    client = initializeClient();

    // Step 3: Get account memo
    const memo = await getAccountMemo(targetAccountId);

    // Step 4: Extract topic ID from memo
    const topicId = extractTopicId(memo);

    // Step 5: Get public key from topic
    const publicKey = await getPublicKeyFromTopic(topicId);

    // Step 6: Encrypt message with hybrid encryption (AES + RSA)
    console.log('Encrypting message...');
    const encryptedPayload = encryptMessage(message, publicKey);
    console.log('✓ Message encrypted');

    // Step 7: Send encrypted message to topic
    await sendMessageToTopic(topicId, encryptedPayload);

    console.log('\n✅ Message sent successfully!\n');

    // Close client
    client.close();
    process.exit(0);

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    if (client) {
      client.close();
    }
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\nShutting down gracefully...');
  if (client) {
    client.close();
  }
  process.exit(0);
});

// Run the application
main();
