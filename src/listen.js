const {
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
  AccountUpdateTransaction,
  AccountInfoQuery
} = require('@hashgraph/sdk');
const path = require('path');
const {
  loadEnvFile,
  initializeClient,
  extractTopicIdFromMemo,
  decryptMessage,
  loadOrGenerateRSAKeyPair,
  getPublicKeyFromTopic,
  encryptMessage
} = require('./common');

// Hedera client setup
let client;

/**
 * Get current account memo
 */
async function getAccountMemo() {
  console.log('Checking account memo...');

  const query = new AccountInfoQuery()
    .setAccountId(client.operatorAccountId);

  const accountInfo = await query.execute(client);
  const memo = accountInfo.accountMemo;

  console.log(`✓ Current account memo: "${memo}"`);
  return memo;
}

/**
 * Create a new Hedera topic with 5 cent fee
 */
async function createTopic() {
  console.log('Creating new topic...');

  const transaction = new TopicCreateTransaction()
    .setTopicMemo(`${client.operatorAccountId} listens here for messages.`)
    .setSubmitKey(client.operatorPublicKey);

  const txResponse = await transaction.execute(client);
  const receipt = await txResponse.getReceipt(client);
  const topicId = receipt.topicId;

  console.log(`✓ Topic created: ${topicId.toString()}`);
  return topicId.toString();
}

/**
 * Publish public key to topic
 */
async function publishPublicKey(topicId, publicKey) {
  console.log('Publishing public key to topic...');

  // Create a message with the public key
  const message = JSON.stringify({
    type: 'PUBLIC_KEY',
    publicKey: publicKey,
    timestamp: Date.now()
  });

  const transaction = new TopicMessageSubmitTransaction({
    topicId: topicId,
    message: message
  });

  const txResponse = await transaction.execute(client);
  await txResponse.getReceipt(client);

  console.log('✓ Public key published to topic');
}

/**
 * Update account memo with topic ID
 */
async function updateAccountMemo(topicId) {
  console.log('Updating account memo...');

  const memo = `Write here: ${topicId}`;

  const transaction = new AccountUpdateTransaction()
    .setAccountId(client.operatorAccountId)
    .setAccountMemo(memo);

  const txResponse = await transaction.execute(client);
  await txResponse.getReceipt(client);

  console.log(`✓ Account memo updated: "${memo}"`);
}

/**
 * Check if topic exists and has a public key message using Mirror Node API
 */
async function checkTopicStatus(topicId) {
  console.log(`Checking topic ${topicId} via Mirror Node...`);

  return new Promise((resolve) => {
    // Use Hedera Mirror Node REST API to get the first message
    const https = require('https');
    const mirrorNodeUrl = `https://testnet.mirrornode.hedera.com/api/v1/topics/${topicId}/messages?limit=1&order=asc`;

    https.get(mirrorNodeUrl, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const response = JSON.parse(data);

          // Check if topic has messages
          if (response.messages && response.messages.length > 0) {
            const firstMessage = response.messages[0];

            // Decode the base64 message
            const messageContent = Buffer.from(firstMessage.message, 'base64').toString('utf8');

            try {
              const parsed = JSON.parse(messageContent);

              if (parsed.type === 'PUBLIC_KEY' && parsed.publicKey) {
                console.log('✓ Topic exists and has public key');
                resolve({ exists: true, hasPublicKey: true });
              } else {
                console.log('✓ Topic exists but first message is not a public key');
                resolve({ exists: true, hasPublicKey: false });
              }
            } catch (e) {
              // First message is not JSON or not a public key
              console.log('✓ Topic exists but first message is not a public key');
              resolve({ exists: true, hasPublicKey: false });
            }
          } else {
            // Topic exists but has no messages
            console.log('✓ Topic exists but has no messages');
            resolve({ exists: true, hasPublicKey: false });
          }
        } catch (error) {
          // Error parsing response - topic might not exist
          console.log('✗ Topic does not exist or is inaccessible');
          resolve({ exists: false, hasPublicKey: false });
        }
      });
    }).on('error', (error) => {
      console.log('✗ Error checking topic via Mirror Node:', error.message);
      resolve({ exists: false, hasPublicKey: false });
    });
  });
}

/**
 * Verify that the local private key can decrypt messages encrypted with the topic's public key
 */
async function verifyKeyPairMatchesTopic(topicId, privateKey) {
  console.log('Verifying local keys match topic...');

  try {
    // Get the public key from the topic
    const topicPublicKey = await getPublicKeyFromTopic(topicId);

    // Create a test message and encrypt it with the topic's public key
    const testMessage = 'key_verification_test';
    const encrypted = encryptMessage(testMessage, topicPublicKey);

    // Try to decrypt it with the local private key
    const decrypted = decryptMessage(encrypted, privateKey);

    if (decrypted === testMessage) {
      console.log('✓ Keys verified - local private key matches topic public key');
      return true;
    } else {
      console.log('✗ Key mismatch - decryption produced wrong result');
      return false;
    }
  } catch (error) {
    console.log('✗ Key verification failed:', error.message);
    return false;
  }
}

/**
 * Decrypt message using RSA private key (supports hybrid encryption RSA + AES)
 * Note: This is a wrapper that calls the common decryptMessage function
 */
// Removed - now using common.decryptMessage

/**
 * Listen for new messages on the topic using Mirror Node API
 */
function listenForMessages(topicId, privateKey) {
  console.log(`\n✓ Listening for messages on topic ${topicId}...`);
  console.log('Polling Mirror Node every 3 seconds...');
  console.log('Press Ctrl+C to exit\n');

  let lastSequenceNumber = 0;
  let isFirstPoll = true;

  // Function to fetch and process new messages
  const pollMessages = () => {
    const https = require('https');
    let url;

    if (isFirstPoll) {
      // First poll: get all messages to find the latest sequence number
      url = `https://testnet.mirrornode.hedera.com/api/v1/topics/${topicId}/messages?order=desc&limit=1`;
    } else {
      // Subsequent polls: get messages after the last sequence number
      url = `https://testnet.mirrornode.hedera.com/api/v1/topics/${topicId}/messages?sequencenumber=gt:${lastSequenceNumber}&order=asc&limit=100`;
    }

    https.get(url, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const response = JSON.parse(data);

          if (response.messages && response.messages.length > 0) {
            if (isFirstPoll) {
              // Set the last sequence number from the most recent message
              lastSequenceNumber = response.messages[0].sequence_number;
              console.log(`Starting from sequence number: ${lastSequenceNumber}\n`);
              isFirstPoll = false;
            } else {
              // Process new messages
              for (const message of response.messages) {
                processMessage(message, privateKey);
                lastSequenceNumber = message.sequence_number;
              }
            }
          } else if (isFirstPoll) {
            // No messages yet
            console.log('No messages in topic yet, waiting for new messages...\n');
            isFirstPoll = false;
          }
        } catch (error) {
          console.error('Error polling messages:', error.message);
        }
      });
    }).on('error', (error) => {
      console.error('Error connecting to Mirror Node:', error.message);
    });
  };

  // Process a single message
  const processMessage = (message, privateKey) => {
    try {
      const content = Buffer.from(message.message, 'base64').toString('utf8');
      const timestamp = new Date(parseFloat(message.consensus_timestamp) * 1000).toISOString();

      try {
        const parsed = JSON.parse(content);

        // Skip public key messages
        if (parsed.type === 'PUBLIC_KEY') {
          console.log(`[${timestamp}] Public key message (skipped)`);
          return;
        }

        // Try to decrypt encrypted messages
        if (parsed.type === 'ENCRYPTED_MESSAGE') {
          try {
            const decrypted = decryptMessage(parsed.data, privateKey);
            console.log('\n--- New message received ---');
            console.log(`[${timestamp}]`);
            console.log(`Sequence: ${message.sequence_number}`);
            console.log(`Message: ${decrypted}\n`);
          } catch (error) {
            console.log('\n--- Encrypted message (cannot decrypt) ---');
            console.log(`[${timestamp}]`);
            console.log(`Error: ${error.message}\n`);
          }
        }
      } catch (e) {
        // Not a JSON message, display as plain text
        console.log('\n--- Plain text message ---');
        console.log(`[${timestamp}]`);
        console.log(`Content: ${content}\n`);
      }
    } catch (error) {
      console.error('Error processing message:', error.message);
    }
  };

  // Start polling immediately and then every 3 seconds
  pollMessages();
  const intervalId = setInterval(pollMessages, 3000);

  // Return cleanup function
  return {
    unsubscribe: () => {
      clearInterval(intervalId);
    }
  };
}

/**
 * Main application flow
 */
async function main() {

  try {
    console.log('=== Write Here - Hedera Encrypted Messaging ===\n');

    // Step 0: Load environment variables from .env file
    loadEnvFile();

    // Step 1: Initialize RSA keys
    const { publicKey, privateKey } = loadOrGenerateRSAKeyPair();

    // Step 2: Initialize Hedera client
    client = initializeClient();

    // Step 3: Check account memo to see if topic ID exists
    const accountMemo = await getAccountMemo();
    let topicId = extractTopicIdFromMemo(accountMemo);

    let needsNewTopic = false;

    if (topicId) {
      console.log(`✓ Found topic ID in memo: ${topicId}`);

      // Step 4: Verify the topic exists and has public key
      const topicStatus = await checkTopicStatus(topicId);

      if (!topicStatus.exists) {
        console.log('⚠ Topic in memo does not exist or is inaccessible');
        needsNewTopic = true;
      } else if (!topicStatus.hasPublicKey) {
        console.log('⚠ Topic exists but missing public key message');
        needsNewTopic = true;
      } else {
        // Step 4.5: Verify local keys match the topic's public key
        const keysMatch = await verifyKeyPairMatchesTopic(topicId, privateKey);

        if (!keysMatch) {
          console.log('\n⚠️  WARNING: Your local private key cannot decrypt messages for this topic!');
          console.log('This means the RSA keys have changed since the topic was created.');
          console.log('\nOptions:');
          console.log('  1. Restore the original RSA keys to data/ folder');
          console.log('  2. Create a new topic with the current keys\n');

          // Ask user what to do
          const readline = require('readline').createInterface({
            input: process.stdin,
            output: process.stdout
          });

          const answer = await new Promise((resolve) => {
            readline.question('Create a new topic? (yes/no): ', (ans) => {
              readline.close();
              resolve(ans.toLowerCase());
            });
          });

          if (answer === 'yes' || answer === 'y') {
            console.log('\n✓ Creating new topic with current keys...');
            needsNewTopic = true;
          } else {
            console.log('\n❌ Cannot proceed without matching keys. Exiting...');
            process.exit(1);
          }
        }
      }
    } else {
      console.log('⚠ No topic ID found in account memo');
      needsNewTopic = true;
    }

    // Step 5: Create new topic if needed
    if (needsNewTopic) {
      console.log('Creating new topic...');
      topicId = await createTopic();

      // Publish public key to new topic
      await publishPublicKey(topicId, publicKey);

      // Update account memo with new topic ID
      await updateAccountMemo(topicId);
    } else {
      // Verify memo is correct format
      const expectedMemo = `Write here: ${topicId}`;
      if (accountMemo !== expectedMemo) {
        console.log('⚠ Account memo format is incorrect, updating...');
        await updateAccountMemo(topicId);
      } else {
        console.log('✓ Account memo is correct');
      }
    }

    // Step 6: Listen for messages
    listenForMessages(topicId, privateKey);

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
