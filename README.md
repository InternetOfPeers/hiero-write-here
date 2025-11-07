# Hiero Message Box - Private Asynchronous Messaging

Hiero Message Box is a simple way for users to set up a message box and receive private messages, for example getting alerts about security communications about their assets or wallet, etc.

[View the interactive presentation](https://internetofpeers.org/hiero-message-box/presentation.html) to visualize the message box flow.

The repo contains the code both for the sender and the receiver.

The goal is to enable users to send encrypted messages to an account's message box just like this:

```bash
npm run send-message -- 0.0.1441 "This is a secret message for you"
```

Users can listen for new messages in real-time using this command:

```bash
npm run listen-for-new-messages
```

Users can also check for historical messages using this command:

```bash
npm run check-messages -- [start-sequence] [end-sequence]
```

On first setup, the program generates/derives encryption keys, creates a Hedera topic as your message box, and updates your account memo with the topic ID in HIP-9999 format.

## Features

- **Dual Encryption Support**: Choose between RSA-2048 or ECIES (Elliptic Curve Integrated Encryption Scheme)
  - **RSA Mode**: Traditional RSA-2048 keys stored in `data/` folder (works with all key types)
  - **ECIES Mode**: Uses your Hedera operator's SECP256K1 key (no separate key files needed)
- **Automatic Key Management**: RSA keys are auto-generated, ECIES keys are derived from your operator credentials
- **Hedera Topics**: Creates and manages Hedera topics for message distribution
- **Key Verification**: Automatically verifies local keys match the topic's public key
- **Mirror Node API**: Uses Hedera Mirror Node for all read operations (account validation, memo retrieval, message polling, topic verification)
- **Real-time Listening**: Continuously polls for new encrypted messages every 3 seconds
- **Message Formats**: Supports both JSON and CBOR encoding formats for flexibility
- **Chunked Messages**: Automatically handles messages larger than 1KB split across multiple chunks by HCS
- **Modular Architecture**: Common functions extracted for reusability and maintainability
- **Minimal External Dependencies**: Uses only Hashgraph SDK v2.76.0 and native Node.js crypto module

## Prerequisites

- Node.js (v14 or higher recommended, v18+ for best compatibility)
- A Hedera testnet or mainnet account
  - Get a free testnet account at: <https://portal.hedera.com/register>

## Installation

1. Clone or download this repository

2. Install dependencies:

   ```bash
   npm install
   ```

3. Create a `.env` file with your Hedera credentials:

   ```bash
   cp .env.example .env
   ```

4. Edit `.env` and add your Hedera account details:

```text
# Hedera Account Configuration
HEDERA_ACCOUNT_ID=0.0.xxxxx
HEDERA_PRIVATE_KEY=302e020100300506032b657004220420...

# Encryption Configuration (optional - defaults to RSA)
# Options: RSA, ECIES
# RSA: Uses RSA-2048 keys (generated and stored in data/ folder)
# ECIES: Uses operator's SECP256K1 key for encryption (derived from HEDERA_PRIVATE_KEY)
#        Note: ECIES requires SECP256K1 - ED25519 keys are not supported
ENCRYPTION_TYPE=RSA

# Network Configuration (optional - defaults to testnet)
HEDERA_NETWORK=testnet
MIRROR_NODE_URL=https://testnet.mirrornode.hedera.com
```

For **mainnet**, change to:

```text
HEDERA_NETWORK=mainnet
MIRROR_NODE_URL=https://mainnet.mirrornode.hedera.com
```

## Usage

### Choosing an Encryption Method

The Hiero Message Box supports two encryption methods:

| Feature          | RSA (Default)              | ECIES                  |
| ---------------- | -------------------------- | ---------------------- |
| Key Management   | Generate & store PEM files | Uses your operator key |
| Key Type Support | All (ED25519, SECP256K1)   | SECP256K1 only         |
| Public Key Size  | 294 bytes                  | 33-65 bytes            |
| Setup Time       | ~50ms (key generation)     | <1ms (key derivation)  |
| Security         | RSA-2048 + AES-256-CBC     | ECDH + AES-256-GCM     |
| Files to Backup  | `data/rsa_*.pem`           | None (uses .env)       |
| Forward Secrecy  | No                         | Yes (ephemeral keys)   |

**Use RSA if:**

- You already have a message box and want to keep it
- Your Hedera account uses ED25519 keys
- You prefer separate encryption keys from your operator key

**Use ECIES if:**

- Your Hedera account uses SECP256K1 keys
- You want to use your Hedera key for everything
- You want faster setup with no key file management
- You prefer forward secrecy (each message uses unique ephemeral keys)

**To enable ECIES**, add to your `.env`:

```bash
ENCRYPTION_TYPE=ECIES
```

**Note:** ED25519 keys cannot use ECIES (signature algorithm, no ECDH support). The system will prompt to switch to RSA if needed.

### Setup Message Box

```bash
npm run setup-message-box
```

The setup process:

1. Loads/generates encryption keys (RSA: `data/*.pem`, ECIES: derived from `HEDERA_PRIVATE_KEY`)
2. Checks existing message box in account memo
3. Verifies keys can decrypt messages
4. Creates new topic if needed, publishes public key
5. Updates account memo with topic ID: `[HIP-9999:0.0.xxxxx]`

### Listen for New Messages

Start the listener to continuously poll for and receive encrypted messages:

```bash
npm run listen-for-new-messages
# or
npm start
```

**Note:** `npm start` runs setup then starts listening.

Polls Mirror Node every 3 seconds, automatically detects and decrypts messages. Press `Ctrl+C` to stop.

### Check Messages

Retrieve and read messages from your message box in a specific range:

```bash
npm run check-messages -- [start-sequence] [end-sequence]
```

**Examples:**

```bash
# Get all messages from sequence 2 onwards (default)
npm run check-messages

# Get all messages from sequence 5 onwards
npm run check-messages -- 5

# Get messages from sequence 5 to 10 (inclusive)
npm run check-messages 5 10
```

Retrieves and decrypts messages in the specified range with timestamps and sequence numbers.

### Send Encrypted Messages

Send an encrypted message to another account:

```bash
npm run send-message -- <account-id> <message> [--cbor]
```

**Examples:**

```bash
npm run send-message -- 0.0.1441 "Hello, secret message!"
npm run send-message -- 0.0.1441 "Hello, secret message!" --cbor
```

**Note:** Use `--` to separate npm options from script arguments.

#### Message Formats

- **JSON (default)**: Human-readable, easy to debug (~510 bytes typical message)
- **CBOR (optional)**: Binary format, ~3-5% smaller (~491 bytes), best for high-volume scenarios

Both formats are auto-detected when reading messages.

#### How it works

1. Fetches recipient's account memo and public key from topic
2. Auto-detects encryption type (RSA or ECIES)
3. Encrypts message (RSA: AES-256+RSA-2048, ECIES: ECDH+AES-256-GCM)
4. Sends encrypted payload to topic (JSON or CBOR)

Recipients automatically detect and decrypt messages when polling.

#### Large Messages

HCS automatically splits messages >1KB into chunks. This application transparently reassembles them before decryption—no size limit.

### Remove Message Box

To remove your message box configuration (clears your account memo):

```bash
npm run remove-message-box
```

Clears account memo but doesn't delete the topic or keys.

## Encryption Methods

### RSA Mode

Hybrid encryption: AES-256-CBC for messages + RSA-2048-OAEP for key exchange. Supports all key types, works with any length messages.

### ECIES Mode

Uses ECDH (secp256k1) + AES-256-GCM. Provides forward secrecy with ephemeral keys, smaller public keys (33 bytes vs 294), and derives keys from your operator credentials. **Requires SECP256K1** (ED25519 not supported).

## Architecture

### Modular Design

The codebase is organized into three main modules:

1. **`lib/common.js`**: Utility functions
   - Environment variable loading from `.env` file
   - RSA hybrid encryption/decryption (AES-256-CBC + RSA-2048-OAEP)
   - ECIES encryption/decryption (ECDH + AES-256-GCM)
   - Encryption type detection and routing
   - Custom CBOR encoder/decoder implementation (RFC 8949 compliant)

2. **`lib/hedera.js`**: Hedera blockchain operations
   - Client initialization (testnet/mainnet)
   - Account memo read (via Mirror Node) and update (via Hedera SDK)
   - Account validation using Mirror Node API
   - Topic creation and message submission
   - Mirror Node URL configuration
   - Topic message queries with pagination support
   - Hedera key parsing and public key derivation (SECP256K1, ED25519)

3. **`lib/message-box.js`**: Core message box logic
   - Message box setup with key verification and encryption type selection
   - RSA key pair generation and management
   - ECIES key derivation from operator credentials
   - Public key publishing and retrieval (with encryption type metadata)
   - Message encryption and sending (JSON/CBOR formats, auto-detecting encryption type)
   - Real-time message polling with sequence tracking
   - Automatic format and encryption type detection and decoding

### Mirror Node API

Uses Hedera Mirror Node REST API for all read operations (cost-free):

- Account validation and memo retrieval
- Topic verification and public key retrieval
- Message polling with pagination
- Historical message queries

### Message Format

All messages submitted to the topic use either JSON or CBOR encoding with a `type` field:

**Public Key Message** (first message in topic, always JSON):

RSA format:

```json
{
  "type": "PUBLIC_KEY",
  "publicKey": "-----BEGIN PUBLIC KEY-----\n...",
  "encryptionType": "RSA"
}
```

ECIES format:

```json
{
  "type": "PUBLIC_KEY",
  "publicKey": {
    "type": "ECIES",
    "key": "03a1b2c3...",
    "curve": "secp256k1"
  },
  "encryptionType": "ECIES"
}
```

**Encrypted Message (JSON format)**:

RSA:

```json
{
  "type": "ENCRYPTED_MESSAGE",
  "format": "json",
  "data": {
    "type": "RSA",
    "encryptedKey": "base64...",
    "iv": "base64...",
    "encryptedData": "base64..."
  }
}
```

ECIES:

```json
{
  "type": "ENCRYPTED_MESSAGE",
  "format": "json",
  "data": {
    "type": "ECIES",
    "ephemeralPublicKey": "hex...",
    "iv": "base64...",
    "encryptedData": "base64...",
    "authTag": "base64...",
    "curve": "secp256k1"
  }
}
```

**Encrypted Message (CBOR format)**: Same structure as JSON, more compact.

Messages are auto-detected (format: JSON/CBOR/plain, encryption: RSA/ECIES) and decrypted accordingly.

## File Structure

```text
./
├── src/
│   ├── setup-message-box.js        # Setup message box for account
│   ├── check-messages.js           # Check existing messages inside the message box
│   ├── listen-for-new-messages.js  # Listener/Receiver application
│   ├── send-message.js             # Sender application
│   ├── remove-message-box.js       # Remove message box configuration
│   └── lib/
│       ├── common.js               # Common utilities (encryption, env loading, CBOR)
│       ├── hedera.js               # Hedera SDK wrappers, client init, key parsing
│       └── message-box.js          # Core message box logic (setup, send, poll)
├── data/
│   ├── rsa_private.pem             # RSA private key (auto-generated, RSA mode only)
│   └── rsa_public.pem              # RSA public key (auto-generated, RSA mode only)
├── docs/                           # Documentation and presentations
├── package.json                    # Dependencies and scripts
├── .env                            # Hedera credentials and config (not committed)
├── .env.example                    # Example environment file
└── .gitignore                      # Git ignore rules
```

## Available NPM Scripts

```bash
npm start                                           # Setup message box and start listening for new messages
npm run setup-message-box                           # Setup/verify message box configuration
npm run listen-for-new-messages                     # Start polling for new messages
npm run check-messages -- [start] [end]             # Read message history (defaults to all messages)
npm run send-message -- <account id> <msg> [--cbor] # Send encrypted message to account
npm run remove-message-box                          # Remove message box (clear account memo)
npm run format                                      # Format code with Prettier
```

**Note:** Use `--` to separate npm options from script arguments when passing parameters.

## Configuration Files

### Environment Variables (`.env`)

Required variables:

```text
HEDERA_ACCOUNT_ID=0.0.xxxxx
HEDERA_PRIVATE_KEY=302e020100300506032b657004220420...
DATA_DIR=./data
```

Optional variables:

```text
# Encryption type (defaults to RSA)
ENCRYPTION_TYPE=RSA  # or ECIES

# Network (defaults to testnet)
HEDERA_NETWORK=testnet
MIRROR_NODE_URL=https://testnet.mirrornode.hedera.com
```

### Encryption Keys

**RSA Mode:**

- `data/rsa_private.pem`: Your private key for decryption (keep secure!)
- `data/rsa_public.pem`: Your public key (published to the topic for others to use)

**ECIES Mode:**

- No separate key files needed
- Keys are derived from `HEDERA_PRIVATE_KEY` in `.env`
- Requires SECP256K1 key type

## Security Notes

- Never commit `.env` or private keys
- RSA mode: private key in `data/rsa_private.pem` for local decryption only
- ECIES mode: operator key in `.env` used for transactions and decryption
- ECIES provides forward secrecy (unique ephemeral key per message)

## Troubleshooting

### Common Issues

- **Missing credentials**: Ensure `.env` exists with valid `HEDERA_ACCOUNT_ID` and `HEDERA_PRIVATE_KEY`
- **Message box not found**: Recipient needs to run `npm run setup-message-box`
- **Cannot decrypt**: Keys don't match topic—restore original keys or create new message box
- **Encryption mismatch**: `ENCRYPTION_TYPE` in `.env` doesn't match message box
- **ECIES with ED25519**: ED25519 doesn't support ECIES—use RSA or SECP256K1 account
- **Mirror Node errors**: Check internet and verify `MIRROR_NODE_URL` matches network

## Performance Comparison

### Encryption Operations

| Operation       | RSA-2048  | ECIES (secp256k1) |
| --------------- | --------- | ----------------- |
| Key Generation  | ~50ms     | <1ms (derived)    |
| Encryption      | ~2ms      | ~1ms              |
| Decryption      | ~3ms      | ~1ms              |
| Public Key Size | 294 bytes | 33 bytes          |

Note: Times are approximate and vary by system.

## Migration Guide

### Switching Encryption Types

1. Update `ENCRYPTION_TYPE` in `.env` (RSA or ECIES)
2. Run `npm run setup-message-box` to create new message box
3. Old message box remains accessible with original keys

**Note:** ECIES requires SECP256K1 key (not ED25519).

## Additional Documentation

- **Interactive Presentation**: Open `docs/presentation.html` in a browser for an animated flow visualization

## References

- [ECIES Specification](https://en.wikipedia.org/wiki/Integrated_Encryption_Scheme)
- [Node.js Crypto Documentation](https://nodejs.org/api/crypto.html)
- [Hedera Documentation](https://docs.hedera.com/)
- [Hedera Key Types](https://docs.hedera.com/hedera/sdks-and-apis/sdks/keys)
- [NIST Elliptic Curve Standards](https://csrc.nist.gov/projects/elliptic-curve-cryptography)
- [RFC 8949 - CBOR Specification](https://datatracker.ietf.org/doc/html/rfc8949)

## License

MIT
