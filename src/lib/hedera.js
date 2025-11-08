const {
  TopicCreateTransaction,
  Client,
  AccountId,
  PrivateKey,
  AccountUpdateTransaction,
  TopicMessageSubmitTransaction,
} = require('@hashgraph/sdk');
const https = require('https');
const crypto = require('crypto');

// == Private functions ========================================================

/**
 * Checks if a transaction was successful.
 * @param {import("@hashgraph/sdk").TransactionReceipt} receipt - The transaction receipt.
 * @returns {boolean} Whether the transaction was successful.
 */
function isTransactionSuccessful(receipt) {
  return receipt.status.toString() === 'SUCCESS';
}

/**
 * Helper to execute a transaction and get its receipt
 * @param {import("@hashgraph/sdk").Transaction} transaction - The transaction to execute
 * @param {import("@hashgraph/sdk").Client} client - The Hedera client
 * @returns {Promise<import("@hashgraph/sdk").TransactionReceipt>} The transaction receipt
 */
async function executeAndGetReceipt(transaction, client) {
  return transaction.execute(client).then(tx => tx.getReceipt(client));
}

/**
 * Helper to sign and freeze transaction with owner private key if provided
 * @param {import("@hashgraph/sdk").Transaction} transaction - The transaction to sign
 * @param {import("@hashgraph/sdk").Client} client - The Hedera client
 * @param {string} ownerPrivateKeyDer - DER-encoded private key
 * @returns {Promise<void>}
 */
async function signWithOwnerKey(transaction, client, ownerPrivateKeyDer) {
  if (ownerPrivateKeyDer) {
    const ownerPrivateKey = PrivateKey.fromStringDer(ownerPrivateKeyDer);
    await transaction.freezeWith(client);
    transaction.sign(ownerPrivateKey);
  }
}

/**
 * Determine Hedera key type from SDK key object
 * @param {import("@hashgraph/sdk").PrivateKey} key - Hedera private key object
 * @returns {string} Key type: 'ED25519' or 'ECDSA_SECP256K1'
 */
function getHederaKeyType(key) {
  return key.type === 'secp256k1' ? 'ECDSA_SECP256K1' : 'ED25519';
}

/**
 * Parse Hedera private key from DER format and extract key type and raw key bytes
 * @param {string} derPrivateKey - DER-encoded private key in hex format
 * @returns {Object} Object with keyType ('ED25519' or 'ECDSA_SECP256K1') and keyBytes (Buffer)
 */
function parseHederaPrivateKey(derPrivateKey) {
  try {
    const privateKey = PrivateKey.fromStringDer(derPrivateKey);
    const keyType = getHederaKeyType(privateKey);

    // Use toBytesRaw() to get raw key bytes (32 bytes for both key types)
    const rawKeyBytes = Buffer.from(privateKey.toBytesRaw());
    const rawKeyHex = rawKeyBytes.toString('hex');

    return {
      keyType,
      keyBytes: rawKeyBytes,
      keyHex: rawKeyHex,
      hederaPrivateKey: privateKey,
    };
  } catch (error) {
    throw new Error(`Failed to parse Hedera private key: ${error.message}`);
  }
}

/**
 * Derive public key from Hedera private key
 * @param {string} derPrivateKey - DER-encoded private key in hex format
 * @returns {Object} Object with publicKeyHex (raw bytes) and keyType
 */
function derivePublicKeyFromHederaKey(derPrivateKey) {
  try {
    const privateKey = PrivateKey.fromStringDer(derPrivateKey);
    const publicKey = privateKey.publicKey;
    const keyType = getHederaKeyType(privateKey);

    // Use toBytesRaw() to get raw key bytes
    // For SECP256K1: 33 bytes (compressed public key)
    // For ED25519: 32 bytes
    const publicKeyBytes = Buffer.from(publicKey.toBytesRaw());
    const publicKeyHex = publicKeyBytes.toString('hex');

    return {
      publicKeyHex,
      keyType,
      hederaPublicKey: publicKey,
    };
  } catch (error) {
    throw new Error(`Failed to derive public key: ${error.message}`);
  }
}

// Public functions

/**
 * Initializes and returns a Hedera client based on environment variables.
 * @returns {import("@hashgraph/sdk").Client} The initialized Hedera client.
 */
function initializeClient() {
  const operatorId = process.env.PAYER_ACCOUNT_ID;
  const operatorKey = process.env.PAYER_PRIVATE_KEY;
  const network = process.env.HEDERA_NETWORK || 'testnet';

  if (!operatorId || !operatorKey) {
    throw new Error(
      '✗ Please set PAYER_ACCOUNT_ID and PAYER_PRIVATE_KEY environment variables'
    );
  }

  const client =
    network.toLowerCase() === 'mainnet'
      ? Client.forMainnet()
      : Client.forTestnet();
  client.setOperator(
    AccountId.fromString(operatorId),
    PrivateKey.fromStringDer(operatorKey)
  );
  console.debug(`✓ Hedera client initialized (${network})`);
  return client;
}

/**
 * Get Mirror Node URL from environment variable or default
 * @returns {string} The Mirror Node URL.
 */
function getMirrorNodeUrl() {
  const network = process.env.HEDERA_NETWORK || 'testnet';
  const defaultUrl =
    network.toLowerCase() === 'mainnet'
      ? 'https://mainnet.mirrornode.hedera.com'
      : 'https://testnet.mirrornode.hedera.com';
  return process.env.MIRROR_NODE_URL || defaultUrl;
}

/**
 * Helper function to make HTTPS requests to the Mirror Node
 * @param {string} endpoint - The API endpoint path (e.g., '/accounts/0.0.123')
 * @param {Object} options - Request options
 * @param {boolean} [options.resolveOnError=false] - If true, resolves with null on error instead of rejecting
 * @returns {Promise<Object>} The parsed JSON response or response object with statusCode
 */
async function mirrorNodeRequest(endpoint, options = {}) {
  const { resolveOnError = false } = options;
  const mirrorNodeUrl = getMirrorNodeUrl();
  const url = `${mirrorNodeUrl}${endpoint}`;

  return new Promise((resolve, reject) => {
    https
      .get(url, res => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            if (resolveOnError) {
              resolve({ statusCode: res.statusCode, data: response });
            } else {
              resolve(response);
            }
          } catch (error) {
            if (resolveOnError) {
              resolve({ statusCode: res.statusCode, data: null, error });
            } else {
              reject(
                new Error(
                  `Failed to parse Mirror Node response: ${error.message}`
                )
              );
            }
          }
        });
      })
      .on('error', error => {
        if (resolveOnError) {
          resolve({ statusCode: null, data: null, error });
        } else {
          reject(new Error(`Mirror Node request failed: ${error.message}`));
        }
      });
  });
}

/**
 * Retrieves the account memo for the account using Mirror Node.
 * @param {string} accountId - The account ID to query.
 * @returns {Promise<string>} The account memo.
 */
async function getAccountMemo(accountId) {
  const response = await mirrorNodeRequest(`/accounts/${accountId}`);
  return response.memo || '';
}

/**
 * Validates if an account ID exists on the Hedera network using Mirror Node.
 * @param {string} accountId - The account ID to validate.
 * @returns {Promise<boolean>} True if the account exists, false otherwise.
 */
async function isValidAccount(accountId) {
  const result = await mirrorNodeRequest(`/accounts/${accountId}`, {
    resolveOnError: true,
  });

  if (result.statusCode === 200 && result.data) {
    // Check if account exists and is not deleted
    return result.data.account && !result.data.deleted;
  }

  return false;
}

/**
 * Updates the account memo.
 * @param {import("@hashgraph/sdk").Client} client - The Hedera client.
 * @param {string} accountId - The account ID to update
 * @param {string} memo - The memo text to set for the account.
 * @param {string} [ownerPrivateKeyDer] - Optional DER-encoded private key of the account owner (required if owner != payer)
 * @returns {Promise<{success: boolean, error?: string}>} The result of the update operation.
 */
async function updateAccountMemo(
  client,
  accountId,
  memo,
  ownerPrivateKeyDer = null
) {
  const transaction = new AccountUpdateTransaction()
    .setAccountId(accountId)
    .setAccountMemo(memo);

  await signWithOwnerKey(transaction, client, ownerPrivateKeyDer);
  const receipt = await executeAndGetReceipt(transaction, client);

  const success = isTransactionSuccessful(receipt);
  console.debug(
    success
      ? `✓ Account ${accountId} updated with memo "${memo}"`
      : `✗ Failed to set memo "${memo}" for account ${accountId}`
  );
  return success
    ? { success: true }
    : { success: false, error: receipt.status.toString() };
}

/**
 * Creates a new topic with a memo indicating the owner listens for messages there.
 * @param {import("@hashgraph/sdk").Client} client - The Hedera client.
 * @param {string} memo - The topic memo
 * @param {string} [ownerPrivateKeyDer] - Optional DER-encoded private key of the topic owner (required if owner != payer)
 * @returns {Promise<{success: boolean, topicId?: string, error?: string}>} The result of the topic creation.
 */
async function createTopic(client, memo, ownerPrivateKeyDer = null) {
  // Use owner's public key if provided, otherwise use operator's public key
  const adminKey = ownerPrivateKeyDer
    ? PrivateKey.fromStringDer(ownerPrivateKeyDer)
    : null;
  const adminPublicKey = adminKey
    ? adminKey.publicKey
    : client.operatorPublicKey;

  const transaction = new TopicCreateTransaction()
    .setTopicMemo(memo)
    .setAdminKey(adminPublicKey);

  await signWithOwnerKey(transaction, client, ownerPrivateKeyDer);
  const receipt = await executeAndGetReceipt(transaction, client);

  const success = isTransactionSuccessful(receipt);
  console.debug(
    success ? `✓ Topic created: ${receipt.topicId}` : `✗ Failed to create topic`
  );
  return success
    ? { success: true, topicId: receipt.topicId.toString() }
    : { success: false, error: receipt.status.toString() };
}

/**
 * Send a message to a topic.
 * @param {import("@hashgraph/sdk").Client} client - The Hedera client
 * @param {string} topicId - The topic ID
 * @param {string} message - The message to submit
 * @returns {Promise<{success: boolean, topicId?: string, error?: string}>} The result of the submission
 */
async function submitMessageToHCS(client, topicId, message) {
  const transaction = new TopicMessageSubmitTransaction({ topicId, message });
  const receipt = await executeAndGetReceipt(transaction, client);

  const success = isTransactionSuccessful(receipt);
  console.debug(
    success
      ? `✓ Message submitted to ${topicId}`
      : `✗ Failed to submit message to ${topicId}`
  );
  return success
    ? { success: true, topicId }
    : { success: false, error: receipt.status.toString() };
}

/**
 * Query Mirror Node for topic messages
 * @param {string} topicId - The topic ID to query
 * @param {Object} options - Query options
 * @param {number} [options.limit] - Maximum number of messages to return
 * @param {string} [options.order] - Order of messages ('asc' or 'desc')
 * @param {number} [options.sequenceNumber] - Sequence number filter (use with operator)
 * @param {string} [options.operator] - Operator for sequence number ('gt', 'gte', 'lt', 'lte')
 * @returns {Promise<Object>} The Mirror Node response
 */
async function queryTopicMessages(topicId, options = {}) {
  const params = new URLSearchParams();

  if (options.limit) params.append('limit', options.limit);
  if (options.order) params.append('order', options.order);
  if (options.sequenceNumber && options.operator) {
    params.append(
      'sequencenumber',
      `${options.operator}:${options.sequenceNumber}`
    );
  }

  const queryString = params.toString();
  const endpoint = `/topics/${topicId}/messages${queryString ? `?${queryString}` : ''}`;

  return mirrorNodeRequest(endpoint);
}

/**
 * Reassemble chunked messages from HCS
 * Messages larger than 1KB are split into multiple chunks by HCS
 * @param {Array} messages - Array of messages from Mirror Node
 * @returns {Array} Array of reassembled messages
 */
function reassembleChunkedMessages(messages) {
  // Ensure we always return an array
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return [];
  }

  const chunkedGroups = new Map(); // Group by initial_transaction_id
  const completeMessages = [];

  messages.forEach(msg => {
    if (!msg || !msg.message) {
      console.warn('⚠ Skipping invalid message:', msg);
      return;
    }

    if (!msg.chunk_info) {
      completeMessages.push(msg);
      return;
    }

    // Create a unique key from initial_transaction_id
    const txId = msg.chunk_info.initial_transaction_id;
    if (!txId || !txId.account_id || !txId.transaction_valid_start) {
      console.warn('⚠ Skipping chunk with invalid transaction ID:', msg);
      return;
    }

    const key = `${txId.account_id}-${txId.transaction_valid_start}-${txId.nonce || 0}`;
    const { number: chunkNum, total: chunkTotal } = msg.chunk_info;

    if (!chunkedGroups.has(key)) {
      chunkedGroups.set(key, {
        chunks: new Array(chunkTotal),
        metadata: { ...msg }, // Copy first chunk's metadata
        total: chunkTotal,
        minSequence: msg.sequence_number,
        maxSequence: msg.sequence_number,
        hasFirstChunk: chunkNum === 1, // Track if we have chunk #1
      });
    }

    const group = chunkedGroups.get(key);
    if (chunkNum === 1) group.hasFirstChunk = true;
    group.chunks[chunkNum - 1] = msg.message;
    if (msg.sequence_number < group.minSequence)
      group.minSequence = msg.sequence_number;
    if (msg.sequence_number > group.maxSequence)
      group.maxSequence = msg.sequence_number;
  });

  // Reassemble chunked messages
  chunkedGroups.forEach((group, key) => {
    // Skip groups that don't have the first chunk (incomplete/truncated)
    if (!group.hasFirstChunk) {
      console.warn(
        `⚠ Skipping incomplete chunked message (transaction ${key}): missing first chunk`
      );
      return;
    }

    // Validate that we have chunks array and it's the right length
    if (
      !group.chunks ||
      !Array.isArray(group.chunks) ||
      group.chunks.length !== group.total
    ) {
      console.warn(
        `⚠ Invalid chunk array for transaction ${key}: expected ${group.total} chunks, got ${group.chunks ? group.chunks.length : 0}`
      );
      return;
    }

    const allChunksPresent = group.chunks.every(
      chunk =>
        chunk !== undefined &&
        chunk !== null &&
        typeof chunk === 'string' &&
        chunk.length > 0
    );

    if (allChunksPresent) {
      try {
        // Decode each base64 chunk to binary, then concatenate
        const binaryChunks = group.chunks.map((chunk, idx) => {
          try {
            return Buffer.from(chunk, 'base64');
          } catch (err) {
            throw new Error(
              `Failed to decode chunk ${idx + 1}: ${err.message}`
            );
          }
        });

        const concatenatedBinary = Buffer.concat(binaryChunks);
        // Re-encode the concatenated binary back to base64
        const reassembledBase64 = concatenatedBinary.toString('base64');

        const reassembledMessage = {
          ...group.metadata,
          message: reassembledBase64,
          sequence_number: group.minSequence,
          _maxSequence: group.maxSequence,
        };
        delete reassembledMessage.chunk_info;
        completeMessages.push(reassembledMessage);
      } catch (error) {
        console.warn(
          `⚠ Error reassembling chunked message (transaction ${key}):`,
          error.message
        );
      }
    } else {
      const received = group.chunks.filter(
        c =>
          c !== undefined && c !== null && typeof c === 'string' && c.length > 0
      ).length;
      console.warn(
        `⚠ Incomplete chunked message (transaction ${key}): ${received}/${group.total} chunks received`
      );
    }
  });

  // Sort by sequence number to maintain order
  return completeMessages.sort((a, b) => a.sequence_number - b.sequence_number);
}

/**
 * Get the latest sequence number from a topic
 * @param {string} topicId - The topic ID
 * @returns {Promise<number|null>} The latest sequence number or null if no messages
 */
async function getLatestSequenceNumber(topicId) {
  try {
    const response = await queryTopicMessages(topicId, {
      order: 'desc',
      limit: 1,
    });
    return response.messages?.[0]?.sequence_number || null;
  } catch (error) {
    throw new Error(`Failed to get latest sequence number: ${error.message}`);
  }
}

/**
 * Get new messages from a topic after a given sequence number
 * @param {string} topicId - The topic ID
 * @param {number} afterSequenceNumber - Get messages after this sequence number
 * @returns {Promise<Array>} Array of messages (with chunks reassembled)
 */
async function getNewMessages(topicId, afterSequenceNumber) {
  try {
    const response = await queryTopicMessages(topicId, {
      sequenceNumber: afterSequenceNumber,
      operator: 'gt',
      order: 'asc',
      limit: 100,
    });
    const messages = response.messages || [];
    return reassembleChunkedMessages(messages);
  } catch (error) {
    throw new Error(`Failed to get new messages: ${error.message}`);
  }
}

/**
 * Get the first message from a topic (typically contains public key)
 * @param {string} topicId - The topic ID
 * @returns {Promise<Object|null>} The first message or null if no messages
 */
async function getFirstTopicMessage(topicId) {
  try {
    const response = await queryTopicMessages(topicId, {
      limit: 1,
      order: 'asc',
    });
    return response.messages?.[0] || null;
  } catch (error) {
    throw new Error(`Failed to get first message: ${error.message}`);
  }
}

/**
 * Get messages in a range from a topic
 * @param {string} topicId - The topic ID
 * @param {number} startSequence - Starting sequence number (inclusive)
 * @param {number} [endSequence] - Ending sequence number (inclusive), if not provided gets all messages from start
 * @returns {Promise<Array>} Array of messages (with chunks reassembled)
 */
async function getMessagesInRange(topicId, startSequence, endSequence) {
  try {
    const allMessages = [];
    let hasMore = true;
    let lastSequence = startSequence - 1;

    while (hasMore) {
      const response = await queryTopicMessages(topicId, {
        sequenceNumber: lastSequence,
        operator: 'gt',
        order: 'asc',
        limit: 100,
      });

      if (!response.messages || response.messages.length === 0) {
        hasMore = false;
        break;
      }

      for (const msg of response.messages) {
        // If we have an end sequence and we've reached it, stop
        if (endSequence && msg.sequence_number > endSequence) {
          hasMore = false;
          break;
        }
        // Only include messages >= startSequence
        if (msg.sequence_number >= startSequence) {
          allMessages.push(msg);
        }
        lastSequence = msg.sequence_number;
      }

      // If we got fewer messages than the limit, we've reached the end
      if (response.messages.length < 100) {
        hasMore = false;
      }
    }

    return reassembleChunkedMessages(allMessages);
  } catch (error) {
    throw new Error(`Failed to get messages in range: ${error.message}`);
  }
}

/**
 * Get account's public key from Mirror Node
 * @param {string} accountId - Account ID (e.g., '0.0.1234')
 * @returns {Promise<{publicKey: string, keyType: string}>} Public key in hex and key type
 */
async function getAccountPublicKey(accountId) {
  try {
    const data = await mirrorNodeRequest(`/accounts/${accountId}`);
    if (!data.key) {
      throw new Error(`No key found for account ${accountId}`);
    }

    // The key object contains the public key in various formats
    // key.key contains the hex-encoded public key
    const publicKeyHex = data.key.key;

    // Determine key type from the key structure
    // ED25519 keys are 32 bytes (64 hex chars)
    // SECP256K1 keys are 33 bytes (66 hex chars) when compressed
    let keyType;
    if (data.key._type === 'ED25519' || publicKeyHex.length === 64) {
      keyType = 'ED25519';
    } else if (
      data.key._type === 'ECDSA_SECP256K1' ||
      publicKeyHex.length === 66
    ) {
      keyType = 'ECDSA_SECP256K1';
    } else {
      // Try to determine from length
      keyType = publicKeyHex.length === 64 ? 'ED25519' : 'ECDSA_SECP256K1';
    }

    return {
      publicKey: publicKeyHex,
      keyType,
    };
  } catch (error) {
    throw new Error(
      `Failed to get public key for account ${accountId}: ${error.message}`
    );
  }
}

// == Exports =================================================================

module.exports = {
  getAccountMemo,
  isValidAccount,
  createTopic,
  initializeClient,
  updateAccountMemo,
  submitMessageToHCS,
  getLatestSequenceNumber,
  getNewMessages,
  getFirstTopicMessage,
  getMessagesInRange,
  parseHederaPrivateKey,
  derivePublicKeyFromHederaKey,
  getAccountPublicKey,
};
