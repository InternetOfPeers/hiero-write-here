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
  parseHederaPrivateKey,
  derivePublicKeyFromHederaKey,
  getAccountPublicKey,
} = require('./hedera');
const {
  encryptMessage,
  decryptMessage,
  encodeCBOR,
  decodeCBOR,
  signMessage,
  verifySignature,
} = require('./crypto');

// == Public functions ========================================================

// IMPORTANT: Two-Key System
// -------------------------
// 1. PAYER_PRIVATE_KEY (Operator/Payer): Pays for all Hedera transactions
// 2. MESSAGE_BOX_OWNER_PRIVATE_KEY (Owner): Signs the first message to prove message box ownership
//    - If not set, defaults to PAYER_PRIVATE_KEY (operator owns the message box)
//    - Allows third-party services to pay for transactions on behalf of users
//
// Verification flow:
// - Owner signs the public key message with MESSAGE_BOX_OWNER_PRIVATE_KEY
// - Signature includes accountId and signer's public key
// - Senders verify signature against account's public key from Mirror Node
// - This proves the account owner authorized the message box, regardless of who paid

/**
 * Sets up the message box for the account by creating a new topic and storing the public key.
 * The key pair is stored in the specified data directory. If the keys does not exist, they are generated.
 * @param {import("@hashgraph/sdk").Client} client
 * @param {string} accountId
 * @param {object} options - Optional configuration
 * @param {boolean} options.skipPrompts - If true, automatically create new message box when conflicts exist
 */
async function setupMessageBox(client, dataDir, accountId, options = {}) {
  const { skipPrompts = false } = options;
  let encryptionType = getEncryptionType();
  const { publicKey, privateKey } = await loadOrGenerateKeyPair(
    dataDir,
    encryptionType
  );
  // Re-fetch encryption type in case it was changed during key loading (ED25519 -> RSA fallback)
  encryptionType = getEncryptionType();

  const ownerPrivateKey = getOwnerPrivateKey();
  const accountMemo = await getAccountMemo(accountId);
  console.debug(`✓ Current account memo: "${accountMemo}"`);

  let needsNewMessageBox = true;
  const messageBoxId = extractMessageBoxIdFromMemo(accountMemo);
  if (messageBoxId) {
    console.log(
      `✓ Found existing message box ${messageBoxId} for account ${accountId}`
    );
    const status = await checkMessageBoxStatus(messageBoxId);

    if (status.exists && !status.hasPublicKey) {
      // Message box exists but doesn't have valid public key
      console.warn(
        `\n⚠ WARNING: Message box ${messageBoxId} exists but has invalid format!`
      );
      if (!skipPrompts) {
        const confirmed = await promptYesNo(
          '? Create new message box? (yes/no): '
        );
        if (!confirmed) {
          console.log('\n✗ Setup cancelled. Exiting.');
          process.exit(1);
        }
      } else {
        console.log('⚙ Auto-creating new message box (skipPrompts=true)');
      }
    } else if (status.exists && status.hasPublicKey) {
      const keysMatch = await verifyKeyPairMatchesTopic(
        messageBoxId,
        privateKey,
        encryptionType
      );
      if (!keysMatch) {
        console.warn(
          `\n⚠ WARNING: Your keys cannot decrypt messages for message box ${messageBoxId}!`
        );
        if (!skipPrompts) {
          const confirmed = await promptYesNo(
            '? Create new message box? (yes/no): '
          );
          if (!confirmed) {
            console.log(
              '\n✗ Messages in the message box cannot be decrypted. Exiting.'
            );
            process.exit(1);
          }
        } else {
          console.log('⚙ Auto-creating new message box (skipPrompts=true)');
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
      `[HIP-XXXX:${accountId}] ${accountId} listens here for HIP-XXXX encrypted messages.`,
      ownerPrivateKey
    );
    if (!result.success)
      throw new Error(`Failed to create new message box: ${result.error}`);

    const newMessageBoxId = result.topicId;
    await publishPublicKey(
      client,
      newMessageBoxId,
      publicKey,
      encryptionType,
      accountId,
      ownerPrivateKey
    );
    await updateAccountMemo(
      client,
      accountId,
      `[HIP-XXXX:${newMessageBoxId}] If you want to contact me, send HIP-XXXX encrypted messages to ${newMessageBoxId}.`,
      ownerPrivateKey
    );
    console.log(
      `✓ Message box ${newMessageBoxId} set up correctly for account ${accountId} (encryption: ${encryptionType})`
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

  const ownerPrivateKey = getOwnerPrivateKey();
  const result = await updateAccountMemo(
    client,
    accountId,
    '',
    ownerPrivateKey
  );
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

  console.log('⚙ Getting first message from message box...');
  const response = await getFirstTopicMessage(messageBoxId);
  if (!response.message) throw new Error('No messages found in topic');
  console.log('✓ First message retrieved');

  // Parse the first message
  const messageContent = Buffer.from(response.message, 'base64').toString(
    'utf8'
  );
  const firstMessage = JSON.parse(messageContent);

  console.log('⚙ Verifying message box ownership via signature...');

  // Check if the message has the new structure with payload and proof
  if (!firstMessage.payload || !firstMessage.proof) {
    throw new Error(
      '⚠ SECURITY WARNING: First message does not have the required structure!\n' +
        '  Expected: { payload: {...}, proof: {...} }\n' +
        '  This message box may be using an old format or could be fraudulent.\n' +
        '  Refusing to send message for security reasons.'
    );
  }

  const { payload, proof } = firstMessage;

  // Check if proof has all required fields
  if (
    !proof.signature ||
    !proof.signerPublicKey ||
    !proof.signerKeyType ||
    !proof.accountId
  ) {
    throw new Error(
      '⚠ SECURITY WARNING: First message proof does not contain required fields!\n' +
        '  This message box may be using an old format or could be fraudulent.\n' +
        '  Refusing to send message for security reasons.'
    );
  }

  // Verify that the accountId in the proof matches the recipient
  if (proof.accountId !== recipientAccountId) {
    throw new Error(
      `⚠ SECURITY WARNING: Message box ${messageBoxId} is for account ${proof.accountId}, not ${recipientAccountId}!\n` +
        `  This could be a misconfigured or fraudulent message box.\n` +
        `  Refusing to send message for security reasons.`
    );
  }

  // Get the recipient account's public key from Mirror Node
  const { publicKey: recipientPublicKey, keyType: recipientKeyType } =
    await getAccountPublicKey(recipientAccountId);

  // Verify that the signer's public key matches the recipient's public key
  if (proof.signerPublicKey !== recipientPublicKey) {
    throw new Error(
      `⚠ SECURITY WARNING: Message box ${messageBoxId} was NOT signed by account ${recipientAccountId}!\n` +
        `  Expected public key: ${recipientPublicKey}\n` +
        `  Signer public key: ${proof.signerPublicKey}\n` +
        `  The account's public key may have changed, or this could be fraudulent.\n` +
        `  Refusing to send message for security reasons.`
    );
  }

  // Verify the signature against the payload (not including proof)
  // Use canonical JSON to ensure deterministic serialization matches signing
  const payloadToVerify = canonicalJSON(payload);
  const isValid = verifySignature(
    payloadToVerify,
    proof.signature,
    proof.signerPublicKey,
    proof.signerKeyType
  );

  if (!isValid) {
    throw new Error(
      '⚠ SECURITY WARNING: Signature verification failed!\n' +
        '  The first message signature is invalid.\n' +
        '  This could be a tampered or fraudulent message box.\n' +
        '  Refusing to send message for security reasons.'
    );
  }

  console.log('✓ Message box ownership verified via signature');
  console.log(`  Account: ${proof.accountId}`);
  console.log(`  Verified with public key from Mirror Node`);

  // Extract the encryption public key from the payload
  const publicKey = payload.publicKey;
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
    const encryptionType = getEncryptionType();
    const { privateKey } = await loadOrGenerateKeyPair(dataDir, encryptionType);
    pollingCache.privateKey = privateKey;
    pollingCache.encryptionType = encryptionType;

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
      pollingCache.encryptionType,
      pollingCache
    );
  }

  return await listenForMessages(
    false,
    pollingCache.messageBoxId,
    pollingCache.privateKey,
    pollingCache.encryptionType,
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
  const encryptionType = getEncryptionType();
  const { privateKey } = await loadOrGenerateKeyPair(dataDir, encryptionType);

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
    messages.push(formatMessage(msg, privateKey, encryptionType));
  });

  return messages;
}

// == Private state & functions ================================================

let pollingCache = { firstCall: true, lastSequenceNumber: 0 };

/**
 * Prompt user for yes/no confirmation
 * @param {string} question - The question to ask
 * @returns {Promise<boolean>} True if user confirms (yes/y), false otherwise
 */
async function promptYesNo(question) {
  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise(resolve => {
    readline.question(question, ans => {
      readline.close();
      resolve(ans.toLowerCase().trim());
    });
  });

  return answer === 'yes' || answer === 'y';
}

/**
 * Get owner's private key from environment
 * @returns {string} MESSAGE_BOX_OWNER_PRIVATE_KEY
 * @throws {Error} If key is not set
 */
function getOwnerPrivateKey() {
  const key = process.env.MESSAGE_BOX_OWNER_PRIVATE_KEY;
  if (!key) {
    throw new Error(
      'MESSAGE_BOX_OWNER_PRIVATE_KEY not found in environment variables'
    );
  }
  return key;
}

/**
 * Canonicalize a JSON object for deterministic signing
 * Sorts keys recursively and serializes to JSON
 * This ensures the same object always produces the same string
 * @param {Object} obj - Object to canonicalize
 * @returns {string} Canonical JSON string
 */
function canonicalJSON(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    return '[' + obj.map(item => canonicalJSON(item)).join(',') + ']';
  }

  // Sort keys alphabetically for deterministic ordering
  const sortedKeys = Object.keys(obj).sort();
  const pairs = sortedKeys.map(key => {
    const value = canonicalJSON(obj[key]);
    return JSON.stringify(key) + ':' + value;
  });

  return '{' + pairs.join(',') + '}';
}

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
 * @param {string|Object} privateKey - RSA private key (PEM string) or ECIES key object
 * @param {string} encryptionType - 'RSA' or 'ECIES'
 * @returns {string} Formatted message string
 */
function formatMessage(msg, privateKey, encryptionType) {
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
    const keyInfo = parsed.encryptionType ? ` (${parsed.encryptionType})` : '';
    const keyPreview = parsed.publicKey
      ? typeof parsed.publicKey === 'string'
        ? parsed.publicKey.substring(0, 50) + '...'
        : JSON.stringify(parsed.publicKey).substring(0, 50) + '...'
      : 'N/A';
    return `[Seq: ${msg.sequence_number}] [${timestamp}] [${format.toUpperCase()}] Public key${keyInfo} published by ${sender}:\n${keyPreview}`;
  } else {
    return `[Seq: ${msg.sequence_number}] [${timestamp}] [${format.toUpperCase()}] Plain text message from ${sender}:\n${raw}`;
  }
}

/**
 * Get the encryption type from environment
 * @returns {string} 'RSA' or 'ECIES'
 */
function getEncryptionType() {
  return (process.env.ENCRYPTION_TYPE || 'RSA').toUpperCase();
}

/**
 * Get public key from topic message
 * @param {string} message - Base64 encoded message content
 * @returns {Promise<string|Object>} Public key (PEM string for RSA, object for ECIES)
 */
async function getPublicKeyFromFirstMessage(message) {
  try {
    const messageContent = Buffer.from(message, 'base64').toString('utf8');
    const firstMessage = JSON.parse(messageContent);

    // Require new structure with payload and proof
    if (!firstMessage.payload) {
      throw new Error(
        'First message does not have the required structure with payload and proof'
      );
    }

    const payload = firstMessage.payload;

    if (payload.type === 'PUBLIC_KEY' && payload.publicKey) {
      const encryptionType = payload.encryptionType || 'RSA';
      console.log(`✓ Public key retrieved from topic (${encryptionType})`);

      // Return the public key in the format expected by encryptMessage
      if (encryptionType === 'ECIES') {
        // For ECIES, payload.publicKey should already be an object with type, key, and curve
        if (
          typeof payload.publicKey === 'object' &&
          payload.publicKey.type === 'ECIES'
        ) {
          // Extract raw key if it's in DER format
          const curve = payload.publicKey.curve || 'secp256k1';
          const rawKey = extractRawPublicKey(payload.publicKey.key, curve);

          return {
            type: 'ECIES',
            key: rawKey,
            curve: curve,
          };
        } else if (typeof payload.publicKey === 'string') {
          // Legacy format: if it's just a hex string, extract raw key and wrap it
          const curve =
            payload.publicKey.length === 66 ? 'secp256k1' : 'ed25519';
          const rawKey = extractRawPublicKey(payload.publicKey, curve);

          return {
            type: 'ECIES',
            key: rawKey,
            curve: curve,
          };
        } else {
          throw new Error('Invalid ECIES public key format');
        }
      } else {
        // For RSA, return the PEM string directly
        return payload.publicKey;
      }
    }
    throw new Error('First message does not contain a public key');
  } catch (error) {
    throw new Error(`Failed to get public key from topic: ${error.message}`);
  }
}

/**
 * Listen for messages
 * @param {boolean} isFirstPoll
 * @param {string} topicId
 * @param {string|Object} privateKey
 * @param {string} encryptionType
 * @param {object} cache
 * @returns {Promise<string[]>}
 */
async function listenForMessages(
  isFirstPoll,
  topicId,
  privateKey,
  encryptionType,
  cache
) {
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
      messages.push(formatMessage(msg, privateKey, encryptionType));

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
 * Publish public key to the message box topic with signature
 * The message box owner signs the public key with their Hedera account's private key
 * @param {import("@hashgraph/sdk").Client} client - Hedera client (operator pays for transaction)
 * @param {string} messageBoxId - Topic ID for the message box
 * @param {string|Object} publicKey - The encryption public key (RSA or ECIES)
 * @param {string} encryptionType - 'RSA' or 'ECIES'
 * @param {string} accountId - The account ID that owns this message box
 */
async function publishPublicKey(
  client,
  messageBoxId,
  publicKey,
  encryptionType,
  accountId,
  accountPrivateKey
) {
  // Parse the account owner's private key
  const { keyHex, keyType } = parseHederaPrivateKey(accountPrivateKey);

  // Get account owner's public key (this will be verified by senders against Mirror Node)
  const { publicKeyHex } = derivePublicKeyFromHederaKey(accountPrivateKey);

  // Create the encryption public key payload (what senders will use to encrypt messages)
  const payload = {
    type: 'PUBLIC_KEY',
    publicKey,
    encryptionType,
  };

  // Sign the payload with the account owner's private key
  // This signature proves that the account owner authorized this message box
  // Use canonical JSON to ensure deterministic serialization for signature verification
  const payloadToSign = canonicalJSON(payload);
  const signature = signMessage(payloadToSign, keyHex, keyType);

  // Create the complete first message with payload and separate signature info
  const firstMessage = {
    payload, // The encryption public key information
    proof: {
      // The ownership proof (separate from payload)
      accountId: accountId,
      signerPublicKey: publicKeyHex,
      signerKeyType: keyType,
      signature: signature,
    },
  };

  // Submit the signed message
  // Note: The operator (client) pays for the transaction (could be a third party)
  // but the signature proves the account owner authorized this message box
  const message = JSON.stringify(firstMessage);
  await submitMessageToHCS(client, messageBoxId, message);
  console.log(
    `✓ Public key published with signature (${encryptionType}, ${keyType})`
  );
  console.log(`  Account: ${accountId}`);
  console.log(`  Signer public key: ${publicKeyHex.substring(0, 16)}...`);
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
      // Require a structure with payload and proof
      if (!parsed.payload) {
        return { exists: true, hasPublicKey: false };
      }
      const payload = parsed.payload;
      return {
        exists: true,
        hasPublicKey: payload.type === 'PUBLIC_KEY' && payload.publicKey,
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
 * Returns the public key in the format expected by encryptMessage
 * @param {string} topicId
 * @returns {Promise<string|Object>} Public key (PEM string for RSA, object for ECIES)
 */
/**
 * Extract raw public key bytes from DER-encoded format
 * @param {string} keyHex - Public key in hex format (might be DER or raw)
 * @param {string} keyType - Key type ('secp256k1' or 'ed25519')
 * @returns {string} Raw key bytes in hex format
 */
function extractRawPublicKey(keyHex, keyType = 'secp256k1') {
  const keyBuffer = Buffer.from(keyHex, 'hex');

  // Check if it's DER format (starts with SEQUENCE tag 0x30)
  if (keyBuffer[0] === 0x30) {
    // DER format - extract raw key from SPKI structure
    // Look for BIT STRING marker (0x03)
    const bitStringIndex = keyBuffer.indexOf(0x03);
    if (bitStringIndex >= 0 && keyBuffer[bitStringIndex + 2] === 0x00) {
      // Skip BIT STRING header (03 xx 00) and get the raw key
      const rawKey = keyBuffer.subarray(bitStringIndex + 3);
      return rawKey.toString('hex');
    }

    // Alternative: known lengths for standard DER encoding
    if (keyType === 'secp256k1' && keyBuffer.length === 45) {
      // Last 33 bytes are the compressed public key
      return keyBuffer.subarray(-33).toString('hex');
    } else if (keyType === 'ed25519' && keyBuffer.length === 44) {
      // Last 32 bytes are the ed25519 public key
      return keyBuffer.subarray(-32).toString('hex');
    }

    throw new Error('Unable to extract raw key from DER format');
  }

  // Already raw format
  return keyHex;
}

/**
 * Check if the provided private key can decrypt messages encrypted with the public key from the topic.
 * @param {string} messageBoxId
 * @param {string|Object} privateKey
 * @param {string} encryptionType
 * @returns {Promise<boolean>}
 */
async function verifyKeyPairMatchesTopic(
  messageBoxId,
  privateKey,
  encryptionType
) {
  try {
    console.log('⚙ Getting first message from message box...');
    const response = await getFirstTopicMessage(messageBoxId);
    if (!response.message) throw new Error('No messages found in topic');
    console.log('✓ First message retrieved');

    const publicKey = await getPublicKeyFromFirstMessage(response.message);
    const topicEncryptionType =
      typeof publicKey === 'object' && publicKey.type === 'ECIES'
        ? 'ECIES'
        : 'RSA';

    if (topicEncryptionType !== encryptionType) {
      console.log(
        `✗ Encryption type mismatch: topic uses ${topicEncryptionType}, but configured for ${encryptionType}`
      );
      return false;
    }

    const testMessage = 'key_verification_test';
    const encrypted = encryptMessage(testMessage, publicKey);
    const decrypted = decryptMessage(encrypted, privateKey);
    return decrypted === testMessage;
  } catch (error) {
    console.log('✗ Key verification failed:', error.message);
    return false;
  }
}

/**
 * Loads existing key pair or generates a new one based on encryption type.
 * @param {string} dataDir - Directory to store keys
 * @param {string} encryptionType - 'RSA' or 'ECIES'
 * @returns {Promise<{ publicKey: string|Object, privateKey: string|Object }>} Key pair
 */
async function loadOrGenerateKeyPair(dataDir, encryptionType) {
  if (encryptionType === 'ECIES') {
    return await loadECIESKeyPair();
  } else {
    return loadOrGenerateRSAKeyPair(dataDir);
  }
}

/**
 * Generate ECIES key pair from message box owner's Hedera private key
 * @returns {{ publicKey: Object, privateKey: Object }} ECIES key pair
 */
function loadECIESKeyPair() {
  console.debug(
    '⚙ Deriving ECIES key pair from message box owner credentials'
  );

  const ownerPrivateKey = getOwnerPrivateKey();
  const { keyHex, keyType, keyBytes } = parseHederaPrivateKey(ownerPrivateKey);

  // ECIES with native Node.js crypto only supports secp256k1
  // ED25519 cannot be used for ECDH (key exchange) - it's a signature scheme
  // Check key type BEFORE attempting to derive public key
  if (keyType !== 'ECDSA_SECP256K1') {
    console.warn(
      `\n⚠ WARNING: ECIES encryption requires a SECP256K1 key, but your Hedera account uses ${keyType}.`
    );
    console.warn(
      `ED25519 is a signature algorithm and cannot be used for ECDH key exchange.\n`
    );

    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve, reject) => {
      readline.question(
        '? Would you like to use RSA encryption instead? (yes/no): ',
        ans => {
          readline.close();
          const answer = ans.toLowerCase().trim();
          if (answer === 'yes' || answer === 'y') {
            console.log('\n⚙ Switching to RSA encryption...');
            // Switch to RSA mode
            process.env.ENCRYPTION_TYPE = 'RSA';
            const dataDir = process.env.RSA_DATA_DIR || './data';
            const rsaKeyPair = loadOrGenerateRSAKeyPair(dataDir);
            console.log(
              '\n💡 Tip: To make this permanent, set ENCRYPTION_TYPE=RSA in your .env file'
            );
            resolve(rsaKeyPair);
          } else {
            console.log(
              '\n⚙ Setup cancelled. Please either:\n' +
                '  1. Set ENCRYPTION_TYPE=RSA in your .env file, or\n' +
                '  2. Use a Hedera account with a SECP256K1 key'
            );
            reject(
              new Error(
                'ECIES encryption requires a SECP256K1 key. Setup cancelled by user.'
              )
            );
          }
        }
      );
    });
  }

  // Now derive the public key (safe because we verified it's SECP256K1)
  const { publicKeyHex } = derivePublicKeyFromHederaKey(ownerPrivateKey);

  // Determine the curve to use
  const curve = 'secp256k1';

  console.log(`✓ ECIES key pair derived (${keyType})`);

  return {
    publicKey: {
      type: 'ECIES',
      key: publicKeyHex,
      curve: curve,
    },
    privateKey: {
      type: 'ECIES',
      key: keyHex,
      curve: curve,
    },
  };
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
 * Extract message box ID from memo. Expected format: "[HIP-XXXX:0.0.xxxxx]"
 * @param {string} memo
 * @returns {string|null} Message box ID or null if not found
 */
function extractMessageBoxIdFromMemo(memo) {
  const match = memo.match(/\[HIP-XXXX:(0\.0\.\d+)\]/);
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
