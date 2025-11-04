const {
  Client,
  PrivateKey,
  AccountId,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
  TopicMessageQuery,
  AccountUpdateTransaction,
  Hbar
} = require('@hashgraph/sdk');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Configuration
const CONFIG_FILE = path.join(__dirname, 'config.json');
const PRIVATE_KEY_FILE = path.join(__dirname, 'rsa_private.pem');
const PUBLIC_KEY_FILE = path.join(__dirname, 'rsa_public.pem');

// Hedera client setup
let client;

/**
 * Initialize Hedera client from environment variables
 */
function initializeClient() {
  const operatorId = process.env.HEDERA_ACCOUNT_ID;
  const operatorKey = process.env.HEDERA_PRIVATE_KEY;

  if (!operatorId || !operatorKey) {
    throw new Error('Please set HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY environment variables');
  }

  client = Client.forTestnet(); // Change to forMainnet() for production
  client.setOperator(AccountId.fromString(operatorId), PrivateKey.fromString(operatorKey));

  console.log('✓ Hedera client initialized');
  return client;
}

/**
 * Generate and save RSA key pair
 */
function generateRSAKeyPair() {
  console.log('Generating new RSA key pair...');
  
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    }
  });

  fs.writeFileSync(PRIVATE_KEY_FILE, privateKey, 'utf8');
  fs.writeFileSync(PUBLIC_KEY_FILE, publicKey, 'utf8');
  
  console.log('✓ RSA key pair generated and saved');
  return { publicKey, privateKey };
}

/**
 * Load existing RSA key pair or generate new one
 */
function loadOrGenerateRSAKeyPair() {
  if (fs.existsSync(PRIVATE_KEY_FILE) && fs.existsSync(PUBLIC_KEY_FILE)) {
    console.log('Loading existing RSA key pair...');
    const privateKey = fs.readFileSync(PRIVATE_KEY_FILE, 'utf8');
    const publicKey = fs.readFileSync(PUBLIC_KEY_FILE, 'utf8');
    console.log('✓ RSA key pair loaded');
    return { publicKey, privateKey };
  }
  
  return generateRSAKeyPair();
}

/**
 * Load configuration from file
 */
function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    console.log('✓ Configuration loaded');
    return config;
  }
  return {};
}

/**
 * Save configuration to file
 */
function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  console.log('✓ Configuration saved');
}

/**
 * Create a new Hedera topic with 5 cent fee
 */
async function createTopic() {
  console.log('Creating new topic...');
  
  const transaction = new TopicCreateTransaction()
    .setTopicMemo('Write Here - Encrypted Messages')
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
 * Check if topic already has a public key message
 */
async function topicHasPublicKey(topicId) {
  return new Promise((resolve) => {
    let foundPublicKey = false;
    let messageCount = 0;
    const timeout = setTimeout(() => {
      resolve(foundPublicKey);
    }, 3000); // Wait 3 seconds to check for existing messages

    new TopicMessageQuery()
      .setTopicId(topicId)
      .setStartTime(0)
      .subscribe(
        client,
        (message) => {
          messageCount++;
          try {
            const content = Buffer.from(message.contents).toString('utf8');
            const parsed = JSON.parse(content);
            if (parsed.type === 'PUBLIC_KEY') {
              foundPublicKey = true;
              clearTimeout(timeout);
              resolve(true);
            }
          } catch (e) {
            // Not a JSON message or not a public key message
          }
        },
        (error) => {
          console.error('Error checking topic:', error);
          clearTimeout(timeout);
          resolve(false);
        }
      );
  });
}

/**
 * Decrypt message using RSA private key
 */
function decryptMessage(encryptedData, privateKey) {
  try {
    const buffer = Buffer.from(encryptedData, 'base64');
    const decrypted = crypto.privateDecrypt(
      {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256'
      },
      buffer
    );
    return decrypted.toString('utf8');
  } catch (error) {
    throw new Error(`Decryption failed: ${error.message}`);
  }
}

/**
 * Listen for new messages on the topic
 */
function listenForMessages(topicId, privateKey) {
  console.log(`\n✓ Listening for messages on topic ${topicId}...`);
  console.log('Press Ctrl+C to exit\n');

  new TopicMessageQuery()
    .setTopicId(topicId)
    .setStartTime(0)
    .subscribe(
      client,
      (message) => {
        const content = Buffer.from(message.contents).toString('utf8');
        
        try {
          const parsed = JSON.parse(content);
          
          // Skip public key messages
          if (parsed.type === 'PUBLIC_KEY') {
            console.log(`[${new Date(message.consensusTimestamp.toDate()).toISOString()}] Public key message (skipped)`);
            return;
          }
          
          // Try to decrypt encrypted messages
          if (parsed.type === 'ENCRYPTED_MESSAGE') {
            try {
              const decrypted = decryptMessage(parsed.data, privateKey);
              console.log(`\n[${new Date(message.consensusTimestamp.toDate()).toISOString()}]`);
              console.log(`From sequence: ${message.sequenceNumber}`);
              console.log(`Message: ${decrypted}\n`);
            } catch (error) {
              console.log(`\n[${new Date(message.consensusTimestamp.toDate()).toISOString()}]`);
              console.log(`Encrypted message (cannot decrypt): ${error.message}\n`);
            }
          }
        } catch (e) {
          // Not a JSON message, display as plain text
          console.log(`\n[${new Date(message.consensusTimestamp.toDate()).toISOString()}]`);
          console.log(`Plain text: ${content}\n`);
        }
      },
      (error) => {
        console.error('Error receiving message:', error);
      }
    );
}

/**
 * Main application flow
 */
async function main() {
  try {
    console.log('=== Write Here - Hedera Encrypted Messaging ===\n');

    // Step 1: Initialize RSA keys
    const { publicKey, privateKey } = loadOrGenerateRSAKeyPair();

    // Step 2: Initialize Hedera client
    initializeClient();

    // Step 3: Load or create configuration
    let config = loadConfig();

    // Step 4: Create topic if needed
    if (!config.topicId) {
      config.topicId = await createTopic();
      saveConfig(config);
      
      // Step 5: Publish public key
      await publishPublicKey(config.topicId, publicKey);
      config.publicKeyPublished = true;
      saveConfig(config);
    } else {
      console.log(`✓ Using existing topic: ${config.topicId}`);
      
      // Check if public key was published
      if (!config.publicKeyPublished) {
        const hasKey = await topicHasPublicKey(config.topicId);
        if (!hasKey) {
          await publishPublicKey(config.topicId, publicKey);
          config.publicKeyPublished = true;
          saveConfig(config);
        } else {
          console.log('✓ Topic already has public key');
          config.publicKeyPublished = true;
          saveConfig(config);
        }
      } else {
        console.log('✓ Public key already published');
      }
    }

    // Step 6: Update account memo if needed
    if (!config.memoUpdated) {
      await updateAccountMemo(config.topicId);
      config.memoUpdated = true;
      saveConfig(config);
    } else {
      console.log('✓ Account memo already updated');
    }

    // Step 7: Listen for messages
    listenForMessages(config.topicId, privateKey);

  } catch (error) {
    console.error('\n❌ Error:', error.message);
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
