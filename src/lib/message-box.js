const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const {
  getAccountMemo,
  updateAccountMemo,
  createTopic,
  submitMessageToHCS,
  getMirrorNodeUrl,
} = require("./hedera");
const { encryptMessage, decryptMessage } = require("./common");

// == Public functions ========================================================

/**
 * Sets up the message box for the account by creating a new topic and storing the public key.
 * The key pair is stored in the specified data directory. If the keys does not exist, they are generated.
 * @param {import("@hashgraph/sdk").Client} client
 * @param {string} accountId
 */
async function setupMessageBox(client, dataDir, accountId) {
  const { publicKey, privateKey } = loadOrGenerateRSAKeyPair(dataDir);

  const accountMemo = await getAccountMemo(client, accountId);
  console.debug(`✓ Current account memo: "${accountMemo}"`);

  // Assume new message box is needed
  let needsNewMessageBox = true;

  messageBoxId = extractMessageBoxIdFromMemo(accountMemo);
  if (messageBoxId) {
    console.debug(
      `✓ Found existing message box ${messageBoxId} for account ${accountId}`
    );
    const status = await checkMessageBoxStatus(messageBoxId);
    if (status.exists && status.hasPublicKey) {
      // Message box exists and has a public key. Checking if keys match...
      const keysMatch = await verifyKeyPairMatchesTopic(
        messageBoxId,
        privateKey
      );
      // If keys does not match, warn the user and ask if they want to create a new message box anyway
      if (!keysMatch) {
        console.warn(
          `\n⚠ WARNING: Your keys cannot decrypt messages for message box ${messageBoxId}!`
        );
        const readline = require("readline").createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        const answer = await new Promise((resolve) => {
          readline.question("? Create new message box? (yes/no): ", (ans) => {
            readline.close();
            resolve(ans.toLowerCase());
          });
        });
        if (!(answer === "yes" || answer === "y")) {
          console.log(
            "\n✗ Messages in the message box cannot be decrypted. Exiting."
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
    result = await createTopic(
      client,
      `[HIP-9999:${client.operatorAccountId}] ${client.operatorAccountId} listens here for HIP-9999 encrypted messages.`
    );
    if (!result.success) {
      throw new Error(`Failed to create new message box: ${result.error}`);
    }
    const messageBoxId = result.topicId;
    await publishPublicKey(client, messageBoxId, publicKey);
    await updateAccountMemo(
      client,
      accountId,
      `[HIP-9999:${messageBoxId}] If you want to contact me, send HIP-9999 encrypted messages to ${messageBoxId}.`
    );
    console.log(
      `✓ Message box ${messageBoxId} set up correctly for account ${accountId}`
    );
    return { success: true, messageBoxId: messageBoxId };
  } else {
    console.log(
      `✓ Message box ${messageBoxId} already set up correctly for account ${accountId}`
    );
    return { success: true, messageBoxId: messageBoxId };
  }
}

/**
 * Removes the message box for the account by clearing the account memo.
 * @param {import("@hashgraph/sdk").Client} Hedera client
 * @param {string} accountId
 */
async function removeMessageBox(client, accountId) {
  const accountMemo = await getAccountMemo(client, accountId);
  if (accountMemo != "") {
    let result = await updateAccountMemo(client, accountId, "");
    if (result.success) {
      console.log(`✓ Message box removed for account ${accountId}`);
      return { success: true };
    }
    console.error(`✗ Failed to remove message box for account ${accountId}`);
    return { success: false, error: result.error };
  } else {
    console.log(`✓ No message box configured for account ${accountId}`);
    return { success: true };
  }
}

/**
 * Send an encrypted message to the recipient's message box.
 * @param {import("@hashgraph/sdk").Client} Hedera client
 * @param {string} recipientAccountId
 * @param {string} message
 */
async function sendMessage(client, recipientAccountId, message) {
  console.log(`⚙ Sending message to account ${recipientAccountId}...`);

  const accountMemo = await getAccountMemo(client, recipientAccountId);
  console.debug(`✓ Account memo: "${accountMemo}"`);

  messageBoxId = extractMessageBoxIdFromMemo(accountMemo);
  if (messageBoxId) {
    console.log(`✓ Message box ID: ${messageBoxId}`);

    // Get public key, encrypt, and send
    const publicKey = await getPublicKeyFromTopic(messageBoxId);
    console.log("⚙ Encrypting message...");
    const encryptedPayload = encryptMessage(message, publicKey);
    console.log("✓ Encrypted");

    console.log(`⚙ Sending to message box ${messageBoxId}...`);
    let result = await submitMessageToHCS(
      client,
      messageBoxId,
      JSON.stringify({ type: "ENCRYPTED_MESSAGE", data: encryptedPayload })
    );
    if (!result.success) {
      throw new Error(`Failed to send message: ${result.error}`);
    }
    console.log(`✓ Encrypted message sent correctly.`);
  } else {
    throw new Error(
      `Message box ID not found for account ${recipientAccountId}`
    );
  }
}

/**
 * Poll for new messages in the message box.
 * @param {import("@hashgraph/sdk").Client} client
 * @param {string} dataDir
 * @param {string} accountId
 * @returns {Promise<string[]>}
 */
async function pollMessages(client, dataDir, accountId) {
  if (pollingCache.firstCall) {
    // Get the private key from the loaded key pair
    const keyPair = loadOrGenerateRSAKeyPair(dataDir);
    pollingCache.privateKey = keyPair.privateKey;

    const accountMemo = await getAccountMemo(client, accountId);
    console.debug(`✓ Current account memo: "${accountMemo}"`);

    messageBoxId = extractMessageBoxIdFromMemo(accountMemo);
    if (messageBoxId) {
      pollingCache.messageBoxId = messageBoxId;
      console.log(
        `✓ Found message box ${messageBoxId} for account ${accountId}`
      );
    } else {
      throw new Error(`Message box ID not found for account ${accountId}`);
    }
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

// == Private state & functions ================================================

let pollingCache = { firstCall: true, lastSequenceNumber: 0 };

/**
 * Listen for messages
 * @param {boolean} isFirstPoll
 * @param {string} topicId
 * @param {string} privateKey
 * @param {object} cache
 * @returns {Promise<string[]>}
 */
async function listenForMessages(isFirstPoll, topicId, privateKey, cache) {
  const url = isFirstPoll
    ? `${getMirrorNodeUrl()}/api/v1/topics/${topicId}/messages?order=desc&limit=1`
    : `${getMirrorNodeUrl()}/api/v1/topics/${topicId}/messages?sequencenumber=gt:${cache.lastSequenceNumber}&order=asc&limit=100`;

  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const response = JSON.parse(data);
            const messages = [];

            if (response.messages?.length > 0) {
              if (isFirstPoll) {
                cache.lastSequenceNumber = response.messages[0].sequence_number;
                console.log(
                  `✓ Starting from sequence: ${cache.lastSequenceNumber}\n`
                );
                resolve(messages); // Return empty array on first poll
              } else {
                response.messages.forEach((msg) => {
                  const content = Buffer.from(msg.message, "base64").toString(
                    "utf8"
                  );
                  const timestamp = new Date(
                    parseFloat(msg.consensus_timestamp) * 1000
                  ).toISOString();

                  try {
                    const parsed = JSON.parse(content);
                    if (parsed.type === "ENCRYPTED_MESSAGE") {
                      try {
                        const decrypted = decryptMessage(
                          parsed.data,
                          privateKey
                        );
                        messages.push(
                          `[${timestamp}] Encrypted message: ${decrypted}`
                        );
                      } catch (error) {
                        messages.push(
                          `[${timestamp}] Encrypted message (cannot decrypt): ${error.message}`
                        );
                      }
                    }
                  } catch {
                    messages.push(
                      `[${timestamp}] Plain text message: ${content}`
                    );
                  }
                  cache.lastSequenceNumber = msg.sequence_number;
                });
                resolve(messages);
              }
            } else {
              resolve(messages); // Return empty array if no messages
            }
          } catch (error) {
            console.error("Error polling:", error.message);
            resolve([]); // Return empty array on error
          }
        });
      })
      .on("error", (error) => {
        console.error("Mirror Node error:", error.message);
        resolve([]); // Return empty array on error
      });
  });
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
    JSON.stringify({ type: "PUBLIC_KEY", publicKey: publicKey })
  );
  console.log("✓ Public key published");
}

/**
 * Check if message box exists and has a public key
 * @param {string} messageBoxId
 * @returns {Promise<{exists: boolean, hasPublicKey: boolean}>}
 */
async function checkMessageBoxStatus(messageBoxId) {
  return new Promise((resolve) => {
    https
      .get(
        `${getMirrorNodeUrl()}/api/v1/topics/${messageBoxId}/messages?limit=1&order=asc`,
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              const response = JSON.parse(data);
              if (response.messages?.[0]) {
                const content = Buffer.from(
                  response.messages[0].message,
                  "base64"
                ).toString("utf8");
                try {
                  const parsed = JSON.parse(content);
                  resolve({
                    exists: true,
                    hasPublicKey:
                      parsed.type === "PUBLIC_KEY" && parsed.publicKey,
                  });
                } catch {
                  resolve({ exists: true, hasPublicKey: false });
                }
              } else {
                resolve({ exists: true, hasPublicKey: false });
              }
            } catch {
              resolve({ exists: false, hasPublicKey: false });
            }
          });
        }
      )
      .on("error", () => resolve({ exists: false, hasPublicKey: false }));
  });
}

/**
 * Get public key from the first message in the topic using Mirror Node REST API
 * @param {string} topicId
 * @returns {Promise<string>} Public key
 */
async function getPublicKeyFromTopic(topicId) {
  // Use Hedera Mirror Node REST API
  const mirrorNodeBaseUrl = getMirrorNodeUrl();
  const mirrorNodeUrl = `${mirrorNodeBaseUrl}/api/v1/topics/${topicId}/messages/1`;

  return new Promise((resolve, reject) => {
    const https = require("https");

    https
      .get(mirrorNodeUrl, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          try {
            const response = JSON.parse(data);

            if (response.message) {
              // Decode the base64 message
              const messageContent = Buffer.from(
                response.message,
                "base64"
              ).toString("utf8");
              const parsed = JSON.parse(messageContent);

              if (parsed.type === "PUBLIC_KEY" && parsed.publicKey) {
                console.log("✓ Public key retrieved from topic");
                resolve(parsed.publicKey);
              } else {
                reject(
                  new Error("First message does not contain a public key")
                );
              }
            } else {
              reject(new Error("No messages found in topic"));
            }
          } catch (error) {
            reject(
              new Error(
                `Failed to parse mirror node response: ${error.message}`
              )
            );
          }
        });
      })
      .on("error", (error) => {
        reject(new Error(`Failed to fetch from mirror node: ${error.message}`));
      });
  });
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
    const testMessage = "key_verification_test";
    const encrypted = encryptMessage(testMessage, messageBoxPublicKey);
    const decrypted = decryptMessage(encrypted, privateKey);
    return decrypted === testMessage;
  } catch (error) {
    console.log("✗ Key verification failed:", error.message);
    return false;
  }
}

/**
 * Generates a new RSA key pair.
 * @returns {{ publicKey: string, privateKey: string }} RSA key pair
 */
function generateRSAKeyPair(dataDir) {
  console.log("⚙ Generating new RSA key pair...");

  // Create data directory if it doesn't exist
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
    },
  });

  fs.writeFileSync(getPrivateKeyFilePath(dataDir), privateKey, "utf8");
  fs.writeFileSync(getPublicKeyFilePath(dataDir), publicKey, "utf8");

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
    console.debug("⚙ Loading existing RSA key pair");
    const privateKey = fs.readFileSync(privateKeyFile, "utf8");
    const publicKey = fs.readFileSync(publicKeyFile, "utf8");
    console.log("✓ RSA key pair loaded");
    return { publicKey, privateKey };
  }

  return generateRSAKeyPair(dataDir);
}

/**
 * Get the file path for the private key.
 * @param {string} dataDir
 * @returns {string} Private key file path
 */
function getPrivateKeyFilePath(dataDir) {
  return path.join(dataDir, "rsa_private.pem");
}

/**
 * Get the file path for the public key.
 * @param {string} dataDir
 * @returns {string} Public key file path
 */
function getPublicKeyFilePath(dataDir) {
  return path.join(dataDir, "rsa_public.pem");
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
};
