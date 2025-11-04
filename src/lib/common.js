const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// == Public functions ========================================================

/**
 * Load environment variables from .env file (native implementation)
 */
function loadEnvFile() {
  const PROJECT_ROOT = findProjectRoot();
  const ENV_FILE = path.join(PROJECT_ROOT, ".env");

  if (!fs.existsSync(ENV_FILE)) {
    console.debug(".env file not found.");
    if (!process.env.DATA_DIR)
      process.env.DATA_DIR = path.join(PROJECT_ROOT, "data");
    if (!process.env.PRIVATE_KEY_FILE)
      process.env.PRIVATE_KEY_FILE = path.join(DATA_DIR, "rsa_private.pem");
    if (!process.env.PUBLIC_KEY_FILE)
      process.env.PUBLIC_KEY_FILE = path.join(DATA_DIR, "rsa_public.pem");
    return;
  }

  try {
    const envContent = fs.readFileSync(ENV_FILE, "utf8");
    const lines = envContent.split("\n");

    for (const line of lines) {
      // Skip empty lines and comments
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith("#")) {
        continue;
      }

      // Parse KEY=VALUE format
      const separatorIndex = trimmedLine.indexOf("=");
      if (separatorIndex !== -1) {
        const key = trimmedLine.substring(0, separatorIndex).trim();
        let value = trimmedLine.substring(separatorIndex + 1).trim();

        // Remove quotes if present
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.substring(1, value.length - 1);
        }

        // Set environment variable if not already set
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }

    console.debug("✓ Environment variables loaded from .env file");
  } catch (error) {
    console.error("✗ Error loading .env file:", error.message);
  }
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
    const cipher = crypto.createCipheriv("aes-256-cbc", aesKey, iv);
    let encryptedMessage = cipher.update(message, "utf8", "base64");
    encryptedMessage += cipher.final("base64");

    // Encrypt the AES key with RSA public key
    const encryptedAesKey = crypto.publicEncrypt(
      {
        key: publicKeyPem,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      aesKey,
    );

    // Return encrypted data as JSON
    return {
      encryptedKey: encryptedAesKey.toString("base64"),
      iv: iv.toString("base64"),
      encryptedData: encryptedMessage,
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
  if (
    typeof encryptedData === "object" &&
    encryptedData.encryptedKey &&
    encryptedData.encryptedData
  ) {
    try {
      // Hybrid encryption: Decrypt AES key with RSA, then decrypt message with AES
      // Decrypt the AES key
      const encryptedAesKey = Buffer.from(encryptedData.encryptedKey, "base64");
      const aesKey = crypto.privateDecrypt(
        {
          key: privateKey,
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        encryptedAesKey,
      );

      // Decrypt the message with AES
      const iv = Buffer.from(encryptedData.iv, "base64");
      const decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, iv);
      let decrypted = decipher.update(
        encryptedData.encryptedData,
        "base64",
        "utf8",
      );
      decrypted += decipher.final("utf8");

      return decrypted;
    } catch (error) {
      throw new Error(`Decryption failed: ${error.message}`);
    }
  } else {
    // Error: Unsupported encryption format
    throw new Error("Unsupported encryption format");
  }
}

// == Private functions =======================================================

/**
 * Find the project root directory by looking for package.json
 * @param {string} startDir - The directory to start searching from
 * @returns {string} The project root directory
 */
function findProjectRoot(startDir = __dirname) {
  let currentDir = startDir;

  while (currentDir !== path.dirname(currentDir)) {
    // Stop at filesystem root
    if (fs.existsSync(path.join(currentDir, "package.json"))) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }

  // Fallback to current directory if package.json not found
  return startDir;
}

// == Exports =================================================================

module.exports = {
  loadEnvFile,
  encryptMessage,
  decryptMessage,
};
