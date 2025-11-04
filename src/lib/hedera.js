const {
  AccountInfoQuery,
  TopicCreateTransaction,
  Client,
  AccountId,
  PrivateKey,
  AccountUpdateTransaction,
  TopicMessageSubmitTransaction,
} = require("@hashgraph/sdk");

// Private functions

/**
 * Checks if a transaction was successful.
 * @param {import("@hashgraph/sdk").TransactionReceipt} receipt - The transaction receipt.
 * @returns {boolean} Whether the transaction was successful.
 */
function isTransactionSuccessful(receipt) {
  return receipt.status.toString() === "SUCCESS";
}

// Public functions

/**
 * Initializes and returns a Hedera client based on environment variables.
 * @returns {import("@hashgraph/sdk").Client} The initialized Hedera client.
 */
function initializeClient() {
  const operatorId = process.env.HEDERA_ACCOUNT_ID;
  const operatorKey = process.env.HEDERA_PRIVATE_KEY;
  const network = process.env.HEDERA_NETWORK || "testnet";

  if (!operatorId || !operatorKey) {
    throw new Error(
      "✗ Please set HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY environment variables"
    );
  }

  // Initialize client based on network configuration
  const client =
    network.toLowerCase() === "mainnet"
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
 * Get Mirror Node URL based on the client's network
 * @param {import("@hashgraph/sdk").Client} client - The Hedera client.
 * @returns {string} The Mirror Node URL.
 */
function getMirrorNodeUrl(client) {
  if (process.env.MIRROR_NODE_URL) {
    return process.env.MIRROR_NODE_URL;
  }
  return client.getMirrorNodeUrl();
}

/**
 * Retrieves the account memo for the account.
 * @param {import("@hashgraph/sdk").Client} client - The Hedera client.
 * @returns {Promise<string>} The account memo.
 */
async function getAccountMemo(client, accountId) {
  const accountInfo = await new AccountInfoQuery()
    .setAccountId(accountId)
    .execute(client);
  return accountInfo.accountMemo;
}

/**
 * Updates the account memo.
 * @param {import("@hashgraph/sdk").Client} client - The Hedera client.
 * @param {string} memo - The memo text to set for the account.
 * @returns {Promise<{success: boolean, error?: string}>} The result of the update operation.
 */
async function updateAccountMemo(client, accountId, memo) {
  const receipt = await new AccountUpdateTransaction()
    .setAccountId(accountId)
    .setAccountMemo(memo)
    .execute(client)
    .then((tx) => tx.getReceipt(client));

  if (isTransactionSuccessful(receipt)) {
    console.debug(`✓ Account ${accountId} updated with memo "${memo}"`);
    return { success: true };
  }
  console.debug(`✗ Failed to set memo "${memo}" for account ${accountId}`);
  return { success: false, error: receipt.status.toString() };
}

/**
 * Creates a new topic with a memo indicating the operator listens for messages there.
 * @param {import("@hashgraph/sdk").Client} client - The Hedera client.
 * @returns {Promise<{success: boolean, topicId?: string, error?: string}>} The result of the topic creation.
 */
async function createTopic(client, memo) {
  const receipt = await new TopicCreateTransaction()
    .setTopicMemo(memo)
    .execute(client)
    .then((tx) => tx.getReceipt(client));

  if (isTransactionSuccessful(receipt)) {
    console.debug(`✓ Topic created: ${receipt.topicId}`);
    return { success: true, topicId: receipt.topicId.toString() };
  }
  console.debug(`✗ Failed to create topic`);
  return { success: false, error: receipt.status.toString() };
}

/**
 * Send a message to a topic.
 * @param {*} client
 * @param {*} topicId
 * @param {*} message
 * @returns
 */
async function submitMessageToHCS(client, topicId, message) {
  const receipt = await new TopicMessageSubmitTransaction({
    topicId,
    message: message,
  })
    .execute(client)
    .then((tx) => tx.getReceipt(client));

  if (isTransactionSuccessful(receipt)) {
    console.debug(`✓ Message submitted to ${topicId}`);
    return { success: true, topicId: topicId };
  }
  console.debug(`✗ Failed to submit message to ${topicId}`);
  return { success: false, error: receipt.status.toString() };
}

// == Exports =================================================================

module.exports = {
  getAccountMemo,
  createTopic,
  initializeClient,
  updateAccountMemo,
  submitMessageToHCS,
  getMirrorNodeUrl,
};
