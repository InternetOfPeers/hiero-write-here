# Hiero Message Box - Encrypted Asynchronous Messaging

Hiero Message Box is a simple way for users to set up a message box to receive private messages, for example getting alerts about security communications about their assets or wallet, etc.

[View the interactive presentation](./docs/presentation.html) to visualize the message box flow.

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

When setting up for the first time, the program will:

- Generate RSA key pairs for encryption/decryption
- Create a Hedera topic as your message box
- Update your account memo with the topic ID in HIP-9999 format

To avoid spam, users can decide to set a paid topic as their message box.

## Features

- **RSA Encryption**: Automatically generates and manages RSA key pairs for message encryption/decryption
- **Hedera Topics**: Creates and manages Hedera topics for message distribution
- **Key Verification**: Automatically verifies local keys match the topic's public key
- **Mirror Node API**: Uses Hedera Mirror Node for reliable message polling and topic verification
- **Real-time Listening**: Continuously polls for new encrypted messages every 3 seconds
- **Message Formats**: Supports both JSON and CBOR encoding formats for flexibility
- **Chunked Messages**: Automatically handles messages larger than 1KB split across multiple chunks by HCS
- **Modular Architecture**: Common functions extracted for reusability and maintainability
- **Zero External Dependencies**: Uses only Hashgraph SDK v2.76.0 and native Node.js functions

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

### Setup Message Box

Before listening for messages, you need to set up your message box:

```bash
npm run setup-message-box
```

This will:

1. Generate and save an RSA key pair in `data/` folder (if not already present)
2. Initialize Hedera client
3. Check if you already have a message box configured in your account memo
4. If found, verify the topic exists and your keys can decrypt messages
5. If not found or keys don't match, create a new Hedera topic as your message box
6. Publish your public key to the topic (as the first message)
7. Update your account memo with the topic ID in HIP-9999 format: `[HIP-9999:0.0.xxxxx] If you want to contact me, send HIP-9999 encrypted messages to 0.0.xxxxx.`

### Listen for New Messages (Real-time Polling)

Start the listener to continuously poll for and receive encrypted messages:

```bash
npm run listen-for-new-messages
# or
npm start
```

**Note:** `npm start` will run `setup-message-box` first, then start listening.

The listener will:

- Load existing RSA keys from `data/` folder
- Extract the message box topic ID from your account memo
- Get the latest sequence number from the topic
- Poll the Mirror Node API every 3 seconds for new messages
- Decrypt and display any encrypted messages in real-time
- Track the last sequence number to avoid duplicate messages

Press `Ctrl+C` to stop listening.

### Check Messages (Read Message History)

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

The script will:

- Load your RSA keys from `data/` folder
- Extract the message box topic ID from your account memo
- Fetch all messages in the specified sequence range
- Decrypt encrypted messages and display them with sequence numbers and timestamps
- Show public key messages and plain text messages

This is useful for:

- Reading message history without waiting for new messages
- Checking specific messages by sequence number
- Auditing all messages in your message box
- Retrieving messages you may have missed

### Send Encrypted Messages (Sender)

Send an encrypted message to another account:

```bash
npm run send-message -- <account-id> <message> [--cbor]
```

**Note:** When using `npm run`, you must include `--` before the arguments to separate npm options from script arguments.

**Examples:**

```bash
# Send message with JSON format (default)
npm run send-message -- 0.0.1441 "Hello, this is a secret message!"

# Send message with CBOR format
npm run send-message -- 0.0.1441 "Hello, this is a secret message!" --cbor

# Alternative: run directly with node (no -- needed)
node src/send-message.js 0.0.1441 "Hello, this is a secret message!" --cbor
```

#### Message Formats

The application supports two message encoding formats:

1. **JSON (default)**: Human-readable, widely supported format
   - Pros: Easy to debug, universally compatible
   - Cons: Larger payload size due to text encoding
   - Best for: Text messages, debugging, maximum compatibility

2. **CBOR (optional)**: Concise Binary Object Representation
   - Pros: Compact binary format, 3-5% smaller payload size
   - Cons: Not human-readable in raw form
   - Best for: High-volume messaging, reduced storage costs
   - Specification: [RFC 8949](https://datatracker.ietf.org/doc/html/rfc8949)

Both formats are automatically detected and decoded when reading messages.

**Size Comparison (encrypted messages):**

For a typical encrypted message "Hello, this is a secret message":

- JSON: 510 bytes
- CBOR: 491 bytes
- **Savings: ~20 bytes (3-5% reduction)**

CBOR savings come from:

- More efficient encoding of field names (binary indices vs strings)
- No JSON syntax overhead (quotes, colons, commas)
- Reduced structural metadata

The savings are relatively constant (~20 bytes per message) regardless of message length, as CBOR primarily optimizes the message structure rather than the encrypted content. This makes CBOR most beneficial for high-volume scenarios where cumulative savings matter.

#### How it works

1. Reads the target account's memo to find the message box topic ID
2. Retrieves the recipient's public key from the first message in the topic via Mirror Node API
3. Generates a random AES-256 key
4. Encrypts the message with AES (fast, suitable for large messages)
5. Encrypts the AES key with the recipient's RSA public key
6. Encodes the encrypted payload as JSON (default) or CBOR (if --cbor flag is used)
7. Sends the encoded payload to the topic with type `ENCRYPTED_MESSAGE`

The recipient will automatically detect the format, decrypt, and display the message when polling.

#### Large Messages and Chunking

The Hedera Consensus Service (HCS) automatically splits messages larger than **1KB** into multiple chunks. This application **transparently handles chunked messages**:

- **Automatic Reassembly**: Messages split across multiple chunks are automatically reassembled before decryption
- **No Size Limit**: Send messages of any size - the system handles chunking transparently
- **Chunk Detection**: Uses `chunk_info` metadata from Mirror Node API to identify and group related chunks
- **Sequential Processing**: Chunks are reassembled in order using `initial_transaction_id` as the grouping key

**Example**: A 2KB message will be split into 2-3 chunks by HCS, but you'll receive it as a single decrypted message.

### Remove Message Box

To remove your message box configuration (clears your account memo):

```bash
npm run remove-message-box
```

This will clear your account memo but will **not** delete the topic or your RSA keys.

## Project Flow

For an at-a-glance animated overview, open:

- docs/animated-flow.html (animated sequence of the end-to-end flow)
- docs/flow-diagram.html (detailed static diagram with callouts)

### Setup (One-time or when creating new message box)

```text
┌─────────────────────────────────────┐
│ 1. Load/Generate RSA Keys           │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│ 2. Initialize Hedera Client         │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│ 3. Check Account Memo for Topic ID  │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│ 4. Verify Topic & Public Key        │
│    (via Mirror Node API)            │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│ 5. Verify Local Keys Match Topic    │
│    (encrypt/decrypt test)           │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│ 6. Create New Topic (if needed)     │
│    - Publish public key             │
│    - Update account memo            │
└─────────────────────────────────────┘
```

### Listener (Receiver)

```text
┌─────────────────────────────────────┐
│ 1. Load RSA Keys & Hedera Client    │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│ 2. Extract Topic ID from Memo       │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│ 3. Get Latest Sequence Number       │
│    (via Mirror Node API)            │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│ 4. Poll for New Messages (Loop)     │
│    - Query Mirror Node API          │
│    - Filter messages > last seq     │
│    - Decrypt ENCRYPTED_MESSAGE      │
│    - Display to console             │
│    - Update last sequence number    │
│    - Wait 3 seconds                 │
└──────────────┬──────────────────────┘
               ↓
               └─────────── (repeat)
```

### Sender

```text
┌─────────────────────────────────────┐
│ 1. Get Target Account ID            │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│ 2. Fetch Account Memo via API       │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│ 3. Extract Topic ID from Memo       │
│    Format: [HIP-9999:0.0.xxxxx]     │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│ 4. Get Public Key via Mirror Node   │
│    (from first message in topic)    │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│ 5. Generate Random AES-256 Key      │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│ 6. Encrypt Message with AES         │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│ 7. Encrypt AES Key with RSA         │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│ 8. Submit Encrypted Payload to      │
│    Topic as JSON with type field    │
└─────────────────────────────────────┘
```

## Encryption Method

This project uses **hybrid encryption** for security and efficiency:

1. **AES-256-CBC**: Fast symmetric encryption for the actual message
2. **RSA-2048-OAEP**: Secure asymmetric encryption for the AES key
3. **SHA-256**: Hash function for OAEP padding

### Why Hybrid Encryption?

- **RSA alone**: Limited to ~190 bytes for 2048-bit keys
- **AES alone**: Requires secure key exchange
- **Hybrid**: Combines the security of RSA with the speed of AES, supporting messages of any length

## Architecture

### Modular Design

The codebase is organized into three main modules:

1. **`lib/common.js`**: Utility functions
   - Environment variable loading from `.env` file
   - Hybrid encryption/decryption (AES-256 + RSA-2048)
   - Custom CBOR encoder/decoder implementation (RFC 8949 compliant)

2. **`lib/hedera.js`**: Hedera blockchain operations
   - Client initialization (testnet/mainnet)
   - Account memo read/update
   - Topic creation and message submission
   - Mirror Node URL configuration

3. **`lib/message-box.js`**: Core message box logic
   - Message box setup with key verification
   - RSA key pair generation and management
   - Public key publishing and retrieval
   - Message encryption and sending (JSON/CBOR formats)
   - Real-time message polling with sequence tracking
   - Automatic format detection and decoding

### Mirror Node API Usage

This application uses the Hedera Mirror Node REST API for all query operations:

- **Topic Verification**: `GET /api/v1/topics/{topicId}/messages?limit=1&order=asc`
  - Checks if topics exist and validates their first message contains a public key
- **Public Key Retrieval**: `GET /api/v1/topics/{topicId}/messages/1`
  - Fetches recipient public keys from topic's first message
- **Message Polling**: `GET /api/v1/topics/{topicId}/messages?sequencenumber=gt:{lastSeq}&order=asc&limit=100`
  - Polls for new messages every 3 seconds
  - Tracks last sequence number to avoid duplicates
  - Filters for messages with type `ENCRYPTED_MESSAGE`
- **Initial Sync**: `GET /api/v1/topics/{topicId}/messages?order=desc&limit=1`
  - Gets the latest sequence number on first poll to avoid processing old messages

### Message Format

All messages submitted to the topic use either JSON or CBOR encoding with a `type` field:

**Public Key Message** (first message in topic, always JSON):

```json
{
  "type": "PUBLIC_KEY",
  "publicKey": "-----BEGIN PUBLIC KEY-----\n..."
}
```

**Encrypted Message (JSON format)**:

```json
{
  "type": "ENCRYPTED_MESSAGE",
  "format": "json",
  "data": {
    "encryptedMessage": "base64...",
    "encryptedKey": "base64...",
    "iv": "base64..."
  }
}
```

**Encrypted Message (CBOR format)**:

CBOR-encoded binary data with the same structure:

```javascript
{
  type: "ENCRYPTED_MESSAGE",
  format: "cbor",
  data: {
    encryptedMessage: <Buffer...>,
    encryptedKey: <Buffer...>,
    iv: <Buffer...>
  }
}
```

When reading messages, the application automatically detects the format by analyzing the first byte:

- CBOR: Major type 0-7 in first byte (binary format)
- JSON: Starts with `{` or `[` (text format)
- Plain text: Fallback for unrecognized formats

### Key Verification System

On setup, the application performs cryptographic verification:

1. Fetches the public key from the topic (first message)
2. Encrypts a test message with the topic's public key
3. Attempts to decrypt it with the local private key
4. If successful: keys match, can decrypt incoming messages
5. If failed: prompts user to create a new topic or restore original keys

This prevents silent failures where messages appear to arrive but can't be decrypted.

### Polling Cache System

The listener maintains a stateful cache to optimize polling:

```javascript
{
  firstCall: true,              // Flag for initial sync
  lastSequenceNumber: 0,        // Last processed message sequence
  messageBoxId: "0.0.xxxxx",   // Topic ID
  privateKey: "..."            // RSA private key (PEM format)
}
```

This allows the listener to:

- Skip processing on first call (just get latest sequence)
- Query only new messages after the last sequence number
- Maintain state across polling cycles without re-reading keys or memo

## File Structure

```text
./
├── src/
│   ├── setup-message-box.js        # Setup message box for account
│   ├── listen-for-new-messages.js  # Listener/Receiver application
│   ├── send-message.js             # Sender application
│   ├── remove-message-box.js       # Remove message box configuration
│   └── lib/
│       ├── common.js               # Common utilities (encryption, env loading)
│       ├── hedera.js               # Hedera SDK wrappers and client initialization
│       └── message-box.js          # Core message box logic (setup, send, poll)
├── data/
│   ├── rsa_private.pem             # RSA private key (auto-generated)
│   └── rsa_public.pem              # RSA public key (auto-generated)
├── package.json                    # Dependencies and scripts
├── .env                            # Hedera credentials (not committed)
├── .env.example                    # Example environment file
└── .gitignore                      # Git ignore rules
```

## Available NPM Scripts

```bash
npm start                                   # Setup message box + start listening
npm run setup-message-box                   # Setup/verify message box configuration
npm run listen-for-new-messages             # Start polling for new messages
npm run check-messages -- [start] [end]     # Read message history (defaults to all messages)
npm run send-message -- <id> <msg> [--cbor] # Send encrypted message to account
npm run remove-message-box                  # Remove message box (clear account memo)
npm run format                              # Format code with Prettier
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

Optional variables (defaults to testnet):

```text
HEDERA_NETWORK=testnet
MIRROR_NODE_URL=https://testnet.mirrornode.hedera.com
```

### RSA Keys (auto-generated in `data/` folder)

- `data/rsa_private.pem`: Your private key for decryption (keep secure!)
- `data/rsa_public.pem`: Your public key (published to the topic for others to use)

## Security Notes

- Never commit your `.env` file or RSA private key
- The private key is only used locally for decryption
- The public key is published to the topic for others to encrypt messages
- Keep your Hedera private key secure

## Network Configuration

The application network is configured via the `.env` file:

### Testnet (Default)

```text
HEDERA_NETWORK=testnet
MIRROR_NODE_URL=https://testnet.mirrornode.hedera.com
```

### Mainnet

```text
HEDERA_NETWORK=mainnet
MIRROR_NODE_URL=https://mainnet.mirrornode.hedera.com
```

If these variables are not set, the application defaults to **testnet**.

## Troubleshooting

### "Please set HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY"

- Ensure `.env` file exists in the project root
- Verify the file contains valid credentials
- Check that variable names match exactly (case-sensitive)

### "Failed to create new message box"

- Verify your account has sufficient HBAR balance
- Check network connectivity to Hedera network
- Ensure you're using the correct network (testnet/mainnet)

### "Message box ID not found for account"

- The target account hasn't set up a message box yet
- The account memo doesn't contain a valid HIP-9999 format: `[HIP-9999:0.0.xxxxx]`
- Ask the recipient to run `npm run setup-message-box` first

### "Cannot decrypt message" or "Encrypted message (cannot decrypt)"

- The message may be encrypted with a different public key than your current one
- This happens if you regenerated your RSA keys after setting up the message box
- Run `npm run setup-message-box` to verify keys or create a new message box

### "Key verification failed" or "Your keys cannot decrypt messages"

- Your local RSA keys don't match the public key published in the topic
- This happens if:
  - You regenerated keys by deleting `data/rsa_*.pem` files
  - You're using the same account on a different machine
  - You restored from backup with different keys
- Solutions:
  - Restore the original RSA keys to the `data/` folder, or
  - Create a new message box with your current keys (will get a new topic ID)

### "Cannot read properties of undefined (reading 'forEach')"

- This was a bug in earlier versions (now fixed)
- The `listenForMessages` function wasn't properly returning a Promise
- Update to the latest version of the code

### Mirror Node Connection Issues

If you see repeated "Mirror Node error" messages:

- Check your internet connection
- Verify `MIRROR_NODE_URL` in `.env` matches your network
- Testnet: `https://testnet.mirrornode.hedera.com`
- Mainnet: `https://mainnet.mirrornode.hedera.com`
- Check Hedera network status: <https://status.hedera.com/>

## License

MIT
