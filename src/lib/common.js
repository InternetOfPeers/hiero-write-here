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

/**
 * Encode data to CBOR format (simplified implementation)
 * Supports: strings, numbers, objects, arrays, booleans, null
 * @param {*} data - Data to encode
 * @returns {Buffer} CBOR encoded data
 */
function encodeCBOR(data) {
  const buffers = [];

  function encode(value) {
    if (value === null) {
      // null -> major type 7, value 22
      buffers.push(Buffer.from([0xf6]));
    } else if (value === undefined) {
      // undefined -> major type 7, value 23
      buffers.push(Buffer.from([0xf7]));
    } else if (typeof value === "boolean") {
      // false -> 0xf4, true -> 0xf5
      buffers.push(Buffer.from([value ? 0xf5 : 0xf4]));
    } else if (typeof value === "number") {
      if (Number.isInteger(value) && value >= 0 && value < 24) {
        // Small positive integer (0-23)
        buffers.push(Buffer.from([value]));
      } else if (Number.isInteger(value) && value >= 0 && value < 256) {
        // Unsigned int (1 byte)
        buffers.push(Buffer.from([0x18, value]));
      } else if (Number.isInteger(value) && value >= 0 && value < 65536) {
        // Unsigned int (2 bytes)
        const buf = Buffer.allocUnsafe(3);
        buf[0] = 0x19;
        buf.writeUInt16BE(value, 1);
        buffers.push(buf);
      } else if (Number.isInteger(value) && value >= 0) {
        // Unsigned int (4 bytes)
        const buf = Buffer.allocUnsafe(5);
        buf[0] = 0x1a;
        buf.writeUInt32BE(value, 1);
        buffers.push(buf);
      } else if (Number.isInteger(value) && value < 0 && value >= -24) {
        // Negative int (-1 to -24)
        buffers.push(Buffer.from([0x20 + (-1 - value)]));
      } else {
        // Float64
        const buf = Buffer.allocUnsafe(9);
        buf[0] = 0xfb;
        buf.writeDoubleBE(value, 1);
        buffers.push(buf);
      }
    } else if (typeof value === "string") {
      // Text string
      const strBuf = Buffer.from(value, "utf8");
      const len = strBuf.length;
      if (len < 24) {
        buffers.push(Buffer.from([0x60 + len]));
      } else if (len < 256) {
        buffers.push(Buffer.from([0x78, len]));
      } else if (len < 65536) {
        const buf = Buffer.allocUnsafe(3);
        buf[0] = 0x79;
        buf.writeUInt16BE(len, 1);
        buffers.push(buf);
      } else {
        const buf = Buffer.allocUnsafe(5);
        buf[0] = 0x7a;
        buf.writeUInt32BE(len, 1);
        buffers.push(buf);
      }
      buffers.push(strBuf);
    } else if (Buffer.isBuffer(value)) {
      // Byte string
      const len = value.length;
      if (len < 24) {
        buffers.push(Buffer.from([0x40 + len]));
      } else if (len < 256) {
        buffers.push(Buffer.from([0x58, len]));
      } else {
        const buf = Buffer.allocUnsafe(5);
        buf[0] = 0x5a;
        buf.writeUInt32BE(len, 1);
        buffers.push(buf);
      }
      buffers.push(value);
    } else if (Array.isArray(value)) {
      // Array
      const len = value.length;
      if (len < 24) {
        buffers.push(Buffer.from([0x80 + len]));
      } else if (len < 256) {
        buffers.push(Buffer.from([0x98, len]));
      } else {
        const buf = Buffer.allocUnsafe(5);
        buf[0] = 0x9a;
        buf.writeUInt32BE(len, 1);
        buffers.push(buf);
      }
      value.forEach((item) => encode(item));
    } else if (typeof value === "object") {
      // Map/Object
      const entries = Object.entries(value);
      const len = entries.length;
      if (len < 24) {
        buffers.push(Buffer.from([0xa0 + len]));
      } else if (len < 256) {
        buffers.push(Buffer.from([0xb8, len]));
      } else {
        const buf = Buffer.allocUnsafe(5);
        buf[0] = 0xba;
        buf.writeUInt32BE(len, 1);
        buffers.push(buf);
      }
      entries.forEach(([key, val]) => {
        encode(key);
        encode(val);
      });
    } else {
      throw new Error(`Unsupported CBOR type: ${typeof value}`);
    }
  }

  encode(data);
  return Buffer.concat(buffers);
}

/**
 * Decode CBOR format to JavaScript data
 * @param {Buffer} buffer - CBOR encoded buffer
 * @returns {*} Decoded data
 */
function decodeCBOR(buffer) {
  let offset = 0;

  function decode() {
    if (offset >= buffer.length) {
      throw new Error("Unexpected end of CBOR data");
    }

    const byte = buffer[offset++];
    const majorType = byte >> 5;
    const additionalInfo = byte & 0x1f;

    function readLength() {
      if (additionalInfo < 24) {
        return additionalInfo;
      } else if (additionalInfo === 24) {
        return buffer[offset++];
      } else if (additionalInfo === 25) {
        const val = buffer.readUInt16BE(offset);
        offset += 2;
        return val;
      } else if (additionalInfo === 26) {
        const val = buffer.readUInt32BE(offset);
        offset += 4;
        return val;
      } else {
        throw new Error(`Unsupported additional info: ${additionalInfo}`);
      }
    }

    switch (majorType) {
      case 0: // Unsigned integer
        return readLength();

      case 1: // Negative integer
        return -1 - readLength();

      case 2: {
        // Byte string
        const len = readLength();
        const data = buffer.slice(offset, offset + len);
        offset += len;
        return data;
      }

      case 3: {
        // Text string
        const len = readLength();
        const data = buffer.toString("utf8", offset, offset + len);
        offset += len;
        return data;
      }

      case 4: {
        // Array
        const len = readLength();
        const arr = [];
        for (let i = 0; i < len; i++) {
          arr.push(decode());
        }
        return arr;
      }

      case 5: {
        // Map
        const len = readLength();
        const obj = {};
        for (let i = 0; i < len; i++) {
          const key = decode();
          const value = decode();
          obj[key] = value;
        }
        return obj;
      }

      case 7: // Special values
        if (additionalInfo === 20) {
          return false;
        } else if (additionalInfo === 21) {
          return true;
        } else if (additionalInfo === 22) {
          return null;
        } else if (additionalInfo === 23) {
          return undefined;
        } else if (additionalInfo === 27) {
          // Float64
          const val = buffer.readDoubleBE(offset);
          offset += 8;
          return val;
        } else {
          throw new Error(`Unsupported special value: ${additionalInfo}`);
        }

      default:
        throw new Error(`Unsupported major type: ${majorType}`);
    }
  }

  return decode();
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
  encodeCBOR,
  decodeCBOR,
};
