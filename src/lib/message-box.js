const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  getAccountMemo,
  isValidAccount,
  updateAccountMemo,
  createTopic,
  submitMessageToHCS,
  getLatestSequenceNumber,
  getNewMessages,
  getFirstTopicMessage,
  getMessagesInRange,
} = require('./hedera');
const {
  encryptMessage,
  decryptMessage,
  encodeCBOR,
  decodeCBOR,
} = require('./common');

// == Public functions ========================================================

/**
 * Sets up the message box for the account by creating a new topic and storing the public key.
 * The key pair is stored in the specified data directory. If the keys does not exist, they are generated.
 * @param {import("@hashgraph/sdk").Client} client
 * @param {string} accountId
 */
async function setupMessageBox(client, dataDir, accountId) {
  const { publicKey, privateKey } = loadOrGenerateRSAKeyPair(dataDir);
  const accountMemo = await getAccountMemo(accountId);
  console.debug(`✓ Current account memo: "${accountMemo}"`);

  let needsNewMessageBox = true;
  const messageBoxId = extractMessageBoxIdFromMemo(accountMemo);
  if (messageBoxId) {
    console.debug(
      `✓ Found existing message box ${messageBoxId} for account ${accountId}`
    );
    const status = await checkMessageBoxStatus(messageBoxId);
    if (status.exists && status.hasPublicKey) {
      const keysMatch = await verifyKeyPairMatchesTopic(
        messageBoxId,
        privateKey
      );
      if (!keysMatch) {
        console.warn(
          `\n⚠ WARNING: Your keys cannot decrypt messages for message box ${messageBoxId}!`
        );
        const readline = require('readline').createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        const answer = await new Promise(resolve => {
          readline.question('? Create new message box? (yes/no): ', ans => {
            readline.close();
            resolve(ans.toLowerCase());
          });
        });
        if (!(answer === 'yes' || answer === 'y')) {
          console.log(
            '\n✗ Messages in the message box cannot be decrypted. Exiting.'
          );
          process.exit(1);
        }
      } else {
        console.log(
          `✓ Existing message box ${messageBoxId} is valid and keys match.`
        );
        needsNewMessageBox = false;
      }
    }
  }

  if (needsNewMessageBox) {
    const result = await createTopic(
      client,
      `[HIP-9999:${client.operatorAccountId}] ${client.operatorAccountId} listens here for HIP-9999 encrypted messages.`
    );
    if (!result.success)
      throw new Error(`Failed to create new message box: ${result.error}`);

    const newMessageBoxId = result.topicId;
    await publishPublicKey(client, newMessageBoxId, publicKey);
    await updateAccountMemo(
      client,
      accountId,
      `[HIP-9999:${newMessageBoxId}] If you want to contact me, send HIP-9999 encrypted messages to ${newMessageBoxId}.`
    );
    console.log(
      `✓ Message box ${newMessageBoxId} set up correctly for account ${accountId}`
    );
    return { success: true, messageBoxId: newMessageBoxId };
  }

  console.log(
    `✓ Message box ${messageBoxId} already set up correctly for account ${accountId}`
  );
  return { success: true, messageBoxId };
}

/**
 * Removes the message box for the account by clearing the account memo.
 * @param {import("@hashgraph/sdk").Client} Hedera client
 * @param {string} accountId
 */
async function removeMessageBox(client, accountId) {
  const accountMemo = await getAccountMemo(accountId);
  if (accountMemo === '') {
    console.log(`✓ No message box configured for account ${accountId}`);
    return { success: true };
  }

  const result = await updateAccountMemo(client, accountId, '');
  console.log(
    result.success
      ? `✓ Message box removed for account ${accountId}`
      : `✗ Failed to remove message box for account ${accountId}`
  );
  return result.success
    ? { success: true }
    : { success: false, error: result.error };
}

/**
 * Send an encrypted message to the recipient's message box.
 * @param {import("@hashgraph/sdk").Client} Hedera client
 * @param {string} recipientAccountId
 * @param {string} message
 * @param {Object} options - Optional parameters
 * @param {boolean} [options.useCBOR=false] - Whether to use CBOR encoding
 */
async function sendMessage(client, recipientAccountId, message, options = {}) {
  if (!(await isValidAccount(recipientAccountId))) {
    throw new Error(
      `${recipientAccountId} is not a valid Hedera account. Please note you need to specify an account with a message box configured. Don't send messages the message box directly.`
    );
  }

  console.log(`⚙ Sending message to account ${recipientAccountId}...`);
  const { useCBOR = false } = options;

  const accountMemo = await getAccountMemo(recipientAccountId);
  console.debug(`✓ Account memo: "${accountMemo}"`);

  const messageBoxId = extractMessageBoxIdFromMemo(accountMemo);
  if (!messageBoxId)
    throw new Error(
      `Message box ID not found for account ${recipientAccountId}`
    );

  console.log(`✓ Message box ID: ${messageBoxId}`);
  const publicKey = await getPublicKeyFromTopic(messageBoxId);
  console.log('⚙ Encrypting message...');
  const encryptedPayload = encryptMessage(message, publicKey);
  console.log('✓ Encrypted');
  console.log(`⚙ Sending to message box ${messageBoxId}...`);

  const messageData = useCBOR
    ? encodeCBOR({
        type: 'ENCRYPTED_MESSAGE',
        format: 'cbor',
        data: encryptedPayload,
      })
    : JSON.stringify({
        type: 'ENCRYPTED_MESSAGE',
        format: 'json',
        data: encryptedPayload,
      });

  if (useCBOR) console.debug('✓ Message encoded with CBOR');

  const result = await submitMessageToHCS(client, messageBoxId, messageData);
  if (!result.success)
    throw new Error(`Failed to send message: ${result.error}`);

  console.log(
    `✓ Encrypted message sent correctly (format: ${useCBOR ? 'CBOR' : 'JSON'}).`
  );
}

/**
 * Poll for new messages in the message box.
 * @param {string} dataDir
 * @param {string} accountId
 * @returns {Promise<string[]>}
 */
async function pollMessages(dataDir, accountId) {
  if (pollingCache.firstCall) {
    const { privateKey } = loadOrGenerateRSAKeyPair(dataDir);
    pollingCache.privateKey = privateKey;

    const accountMemo = await getAccountMemo(accountId);
    console.debug(`✓ Current account memo: "${accountMemo}"`);

    const messageBoxId = extractMessageBoxIdFromMemo(accountMemo);
    if (!messageBoxId)
      throw new Error(`Message box ID not found for account ${accountId}`);

    pollingCache.messageBoxId = messageBoxId;
    console.log(`✓ Found message box ${messageBoxId} for account ${accountId}`);
    pollingCache.firstCall = false;
    return await listenForMessages(
      true,
      pollingCache.messageBoxId,
      pollingCache.privateKey,
      pollingCache
    );
  }

  return await listenForMessages(
    false,
    pollingCache.messageBoxId,
    pollingCache.privateKey,
    pollingCache
  );
}

/**
 * Check messages in a range for the account's message box.
 * @param {string} dataDir
 * @param {string} accountId
 * @param {number} startSequence - Starting sequence number (inclusive)
 * @param {number} [endSequence] - Ending sequence number (inclusive), if not provided gets all messages from start
 * @returns {Promise<string[]>}
 */
async function checkMessages(dataDir, accountId, startSequence, endSequence) {
  const { privateKey } = loadOrGenerateRSAKeyPair(dataDir);

  const accountMemo = await getAccountMemo(accountId);
  console.debug(`✓ Current account memo: "${accountMemo}"`);

  const messageBoxId = extractMessageBoxIdFromMemo(accountMemo);
  if (!messageBoxId) {
    throw new Error(`Message box ID not found for account ${accountId}`);
  }

  console.log(`✓ Found message box ${messageBoxId} for account ${accountId}`);

  const endMsg = endSequence ? ` to ${endSequence}` : ' onwards';
  console.log(
    `⚙ Fetching messages from sequence ${startSequence}${endMsg}...\n`
  );

  const rawMessages = await getMessagesInRange(
    messageBoxId,
    startSequence,
    endSequence
  );
  const messages = [];

  rawMessages.forEach(msg => {
    messages.push(formatMessage(msg, privateKey));
  });

  return messages;
}

// == Private state & functions ================================================

let pollingCache = { firstCall: true, lastSequenceNumber: 0 };

/**
 * Parse message content supporting both JSON and CBOR formats
 * @param {Buffer} messageBuffer - Base64 decoded message buffer
 * @returns {Object|null} Parsed message object or null if parsing fails
 */
function parseMessageContent(messageBuffer) {
  // Check first byte for CBOR major type (0-7)
  // CBOR major types are encoded in the top 3 bits
  const firstByte = messageBuffer[0];
  const majorType = firstByte >> 5;

  // If the first byte indicates a valid CBOR major type (0-7) and is not '{' or '[' (JSON starters)
  // try CBOR first
  if (
    majorType >= 0 &&
    majorType <= 7 &&
    firstByte !== 0x7b &&
    firstByte !== 0x5b
  ) {
    try {
      const parsed = decodeCBOR(messageBuffer);
      // Verify it's a valid message object with expected structure
      if (parsed && typeof parsed === 'object' && parsed.type) {
        return { parsed, format: 'cbor', raw: messageBuffer };
      }
    } catch {
      // Fall through to try JSON
    }
  }

  try {
    // Try to parse as JSON
    const content = messageBuffer.toString('utf8');
    return { parsed: JSON.parse(content), format: 'json', raw: content };
  } catch {
    // If both fail, return as plain text
    return {
      parsed: null,
      format: 'plain',
      raw: messageBuffer.toString('utf8'),
    };
  }
}

/**
 * Parse and format a raw message into a human-readable string
 * @param {Object} msg - Raw message object from Hedera
 * @param {string} privateKey - RSA private key for decryption
 * @returns {string} Formatted message string
 */
function formatMessage(msg, privateKey) {
  const messageBuffer = Buffer.from(msg.message, 'base64');
  const timestamp = new Date(
    parseFloat(msg.consensus_timestamp) * 1000
  ).toISOString();
  const sender = msg.payer_account_id;

  const { parsed, format, raw } = parseMessageContent(messageBuffer);

  if (parsed && parsed.type === 'ENCRYPTED_MESSAGE') {
    try {
      const decrypted = decryptMessage(parsed.data, privateKey);
      return `[Seq: ${msg.sequence_number}] [${timestamp}] [${format.toUpperCase()}] Encrypted message from ${sender}:\n${decrypted}`;
    } catch (error) {
      return `[Seq: ${msg.sequence_number}] [${timestamp}] [${format.toUpperCase()}] Encrypted message from ${sender} (cannot decrypt):\n${error.message}`;
    }
  } else if (parsed && parsed.type === 'PUBLIC_KEY') {
    return `[Seq: ${msg.sequence_number}] [${timestamp}] [${format.toUpperCase()}] Public key published by ${sender}:\n${parsed.publicKey}`;
  } else {
    return `[Seq: ${msg.sequence_number}] [${timestamp}] [${format.toUpperCase()}] Plain text message from ${sender}:\n${raw}`;
  }
}

/**
 * Listen for messages
 * @param {boolean} isFirstPoll
 * @param {string} topicId
 * @param {string} privateKey
 * @param {object} cache
 * @returns {Promise<string[]>}
 */
async function listenForMessages(isFirstPoll, topicId, privateKey, cache) {
  try {
    if (isFirstPoll) {
      const latestSeq = await getLatestSequenceNumber(topicId);
      if (latestSeq) {
        cache.lastSequenceNumber = latestSeq;
        console.log(`✓ Starting from sequence: ${cache.lastSequenceNumber}\n`);
      }
      return [];
    }

    const newMessages = await getNewMessages(topicId, cache.lastSequenceNumber);
    const messages = [];

    newMessages.forEach(msg => {
      messages.push(formatMessage(msg, privateKey));

      const lastSeq = msg._maxSequence || msg.sequence_number;
      if (lastSeq > cache.lastSequenceNumber)
        cache.lastSequenceNumber = lastSeq;
    });

    return messages;
  } catch (error) {
    console.error('Error polling:', error.message);
    return [];
  }
}

/**
 * Publish public key to the message box topic
 * @param {import("@hashgraph/sdk").Client} client
 * @param {string} messageBoxId
 * @param {string} publicKey
 */
async function publishPublicKey(client, messageBoxId, publicKey) {
  await submitMessageToHCS(
    client,
    messageBoxId,
    JSON.stringify({ type: 'PUBLIC_KEY', publicKey })
  );
  console.log('✓ Public key published');
}

/**
 * Check if message box exists and has a public key
 * @param {string} messageBoxId
 * @returns {Promise<{exists: boolean, hasPublicKey: boolean}>}
 */
async function checkMessageBoxStatus(messageBoxId) {
  try {
    const firstMessage = await getFirstTopicMessage(messageBoxId);
    if (!firstMessage) return { exists: true, hasPublicKey: false };

    const content = Buffer.from(firstMessage.message, 'base64').toString(
      'utf8'
    );
    try {
      const parsed = JSON.parse(content);
      return {
        exists: true,
        hasPublicKey: parsed.type === 'PUBLIC_KEY' && parsed.publicKey,
      };
    } catch {
      return { exists: true, hasPublicKey: false };
    }
  } catch {
    return { exists: false, hasPublicKey: false };
  }
}

/**
 * Get public key from the first message in the topic using Mirror Node REST API
 * @param {string} topicId
 * @returns {Promise<string>} Public key
 */
async function getPublicKeyFromTopic(topicId) {
  try {
    const response = await getFirstTopicMessage(topicId);
    if (!response.message) throw new Error('No messages found in topic');

    const messageContent = Buffer.from(response.message, 'base64').toString(
      'utf8'
    );
    const parsed = JSON.parse(messageContent);

    if (parsed.type === 'PUBLIC_KEY' && parsed.publicKey) {
      console.log('✓ Public key retrieved from topic');
      return parsed.publicKey;
    }
    throw new Error('First message does not contain a public key');
  } catch (error) {
    throw new Error(`Failed to get public key from topic: ${error.message}`);
  }
}

/**
 * Check if the provided private key can decrypt messages encrypted with the public key from the topic.
 * @param {string} messageBoxId
 * @param {string} privateKey
 * @returns {Promise<boolean>}
 */
async function verifyKeyPairMatchesTopic(messageBoxId, privateKey) {
  try {
    const messageBoxPublicKey = await getPublicKeyFromTopic(messageBoxId);
    const testMessage = 'key_verification_test';
    const encrypted = encryptMessage(testMessage, messageBoxPublicKey);
    const decrypted = decryptMessage(encrypted, privateKey);
    return decrypted === testMessage;
  } catch (error) {
    console.log('✗ Key verification failed:', error.message);
    return false;
  }
}

/**
 * Generates a new RSA key pair.
 * @returns {{ publicKey: string, privateKey: string }} RSA key pair
 */
function generateRSAKeyPair(dataDir) {
  console.log('⚙ Generating new RSA key pair...');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  fs.writeFileSync(getPrivateKeyFilePath(dataDir), privateKey, 'utf8');
  fs.writeFileSync(getPublicKeyFilePath(dataDir), publicKey, 'utf8');
  console.log(`✓ RSA key pair generated and saved to ${dataDir}`);
  return { publicKey, privateKey };
}

/**
 * Loads existing RSA key pair from files or generates a new one if not found.
 * @returns {{ publicKey: string, privateKey: string }} RSA key pair
 */
function loadOrGenerateRSAKeyPair(dataDir) {
  const privateKeyFile = getPrivateKeyFilePath(dataDir);
  const publicKeyFile = getPublicKeyFilePath(dataDir);

  if (fs.existsSync(privateKeyFile) && fs.existsSync(publicKeyFile)) {
    console.debug('⚙ Loading existing RSA key pair');
    const privateKey = fs.readFileSync(privateKeyFile, 'utf8');
    const publicKey = fs.readFileSync(publicKeyFile, 'utf8');
    console.log('✓ RSA key pair loaded');
    return { publicKey, privateKey };
  }

  return generateRSAKeyPair(dataDir);
}

function getPrivateKeyFilePath(dataDir) {
  return path.join(dataDir, 'rsa_private.pem');
}

function getPublicKeyFilePath(dataDir) {
  return path.join(dataDir, 'rsa_public.pem');
}

/**
 * Extract message box ID from memo. Expected format: "[HIP-9999:0.0.xxxxx]"
 * @param {string} memo
 * @returns {string|null} Message box ID or null if not found
 */
function extractMessageBoxIdFromMemo(memo) {
  const match = memo.match(/\[HIP-9999:(0\.0\.\d+)\]/);
  return match ? match[1] : null;
}

// == Exports =================================================================

module.exports = {
  setupMessageBox,
  removeMessageBox,
  sendMessage,
  pollMessages,
  checkMessages,
};
