const {
    Client,
    PrivateKey,
    AccountId
} = require('@hashgraph/sdk');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Configuration paths
const ENV_FILE = path.join(__dirname, '..', '.env');
const DATA_DIR = path.join(__dirname, '..', 'data');
const PRIVATE_KEY_FILE = path.join(DATA_DIR, 'rsa_private.pem');
const PUBLIC_KEY_FILE = path.join(DATA_DIR, 'rsa_public.pem');

/**
 * Load environment variables from .env file (native implementation)
 */
function loadEnvFile() {
    if (!fs.existsSync(ENV_FILE)) {
        console.warn('Warning: .env file not found');
        return;
    }

    try {
        const envContent = fs.readFileSync(ENV_FILE, 'utf8');
        const lines = envContent.split('\n');

        for (const line of lines) {
            // Skip empty lines and comments
            const trimmedLine = line.trim();
            if (!trimmedLine || trimmedLine.startsWith('#')) {
                continue;
            }

            // Parse KEY=VALUE format
            const separatorIndex = trimmedLine.indexOf('=');
            if (separatorIndex !== -1) {
                const key = trimmedLine.substring(0, separatorIndex).trim();
                let value = trimmedLine.substring(separatorIndex + 1).trim();

                // Remove quotes if present
                if ((value.startsWith('"') && value.endsWith('"')) ||
                    (value.startsWith("'") && value.endsWith("'"))) {
                    value = value.substring(1, value.length - 1);
                }

                // Set environment variable if not already set
                if (!process.env[key]) {
                    process.env[key] = value;
                }
            }
        }

        console.log('✓ Environment variables loaded from .env file');
    } catch (error) {
        console.error('Error loading .env file:', error.message);
    }
}

/**
 * Initialize Hedera client from environment variables
 */
function initializeClient() {
    const operatorId = process.env.HEDERA_ACCOUNT_ID;
    const operatorKey = process.env.HEDERA_PRIVATE_KEY;

    if (!operatorId || !operatorKey) {
        throw new Error('Please set HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY environment variables');
    }

    const client = Client.forTestnet(); // Change to forMainnet() for production
    client.setOperator(AccountId.fromString(operatorId), PrivateKey.fromString(operatorKey));

    console.log('✓ Hedera client initialized');
    return client;
}

/**
 * Extract topic ID from memo
 */
function extractTopicIdFromMemo(memo) {
    // Expected format: "Write here: 0.0.xxxxx"
    const match = memo.match(/0\.0\.\d+/);
    if (match) {
        return match[0];
    }
    return null;
}

/**
 * Get public key from the first message in the topic using Mirror Node REST API
 */
async function getPublicKeyFromTopic(topicId) {
    console.log(`Fetching public key from topic ${topicId}...`);

    // Use Hedera Mirror Node REST API
    const mirrorNodeUrl = `https://testnet.mirrornode.hedera.com/api/v1/topics/${topicId}/messages/1`;

    return new Promise((resolve, reject) => {
        const https = require('https');

        https.get(mirrorNodeUrl, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    const response = JSON.parse(data);

                    if (response.message) {
                        // Decode the base64 message
                        const messageContent = Buffer.from(response.message, 'base64').toString('utf8');
                        const parsed = JSON.parse(messageContent);

                        if (parsed.type === 'PUBLIC_KEY' && parsed.publicKey) {
                            console.log('✓ Public key retrieved from topic');
                            resolve(parsed.publicKey);
                        } else {
                            reject(new Error('First message does not contain a public key'));
                        }
                    } else {
                        reject(new Error('No messages found in topic'));
                    }
                } catch (error) {
                    reject(new Error(`Failed to parse mirror node response: ${error.message}`));
                }
            });
        }).on('error', (error) => {
            reject(new Error(`Failed to fetch from mirror node: ${error.message}`));
        });
    });
}

/**
 * Encrypt message using hybrid encryption (AES + RSA)
 * 1. Generate AES key
 * 2. Encrypt message with AES
 * 3. Encrypt AES key with RSA
 */
function encryptMessage(message, publicKeyPem) {
    try {
        // Generate random AES-256 key
        const aesKey = crypto.randomBytes(32); // 256 bits
        const iv = crypto.randomBytes(16); // 128 bits IV for AES

        // Encrypt the message with AES
        const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
        let encryptedMessage = cipher.update(message, 'utf8', 'base64');
        encryptedMessage += cipher.final('base64');

        // Encrypt the AES key with RSA public key
        const encryptedAesKey = crypto.publicEncrypt(
            {
                key: publicKeyPem,
                padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
                oaepHash: 'sha256'
            },
            aesKey
        );

        // Return encrypted data as JSON
        return {
            encryptedKey: encryptedAesKey.toString('base64'),
            iv: iv.toString('base64'),
            encryptedData: encryptedMessage
        };
    } catch (error) {
        throw new Error(`Encryption failed: ${error.message}`);
    }
}

/**
 * Decrypt message using hybrid encryption (RSA + AES)
 */
function decryptMessage(encryptedData, privateKey) {
    // Check if it's hybrid encryption (AES + RSA)
    if (typeof encryptedData === 'object' && encryptedData.encryptedKey && encryptedData.encryptedData) {
        try {
            // Hybrid encryption: Decrypt AES key with RSA, then decrypt message with AES
            // Decrypt the AES key
            const encryptedAesKey = Buffer.from(encryptedData.encryptedKey, 'base64');
            const aesKey = crypto.privateDecrypt(
                {
                    key: privateKey,
                    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
                    oaepHash: 'sha256'
                },
                encryptedAesKey
            );

            // Decrypt the message with AES
            const iv = Buffer.from(encryptedData.iv, 'base64');
            const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
            let decrypted = decipher.update(encryptedData.encryptedData, 'base64', 'utf8');
            decrypted += decipher.final('utf8');

            return decrypted;
        } catch (error) {
            throw new Error(`Decryption failed: ${error.message}`);
        }
    } else {
        // Error: Unsupported encryption format
        throw new Error('Unsupported encryption format');
    }
}

/**
 * Generate and save RSA key pair
 */
function generateRSAKeyPair() {
    console.log('Generating new RSA key pair...');

    // Create data directory if it doesn't exist
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

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

module.exports = {
    loadEnvFile,
    initializeClient,
    extractTopicIdFromMemo,
    getPublicKeyFromTopic,
    encryptMessage,
    decryptMessage,
    generateRSAKeyPair,
    loadOrGenerateRSAKeyPair
};
