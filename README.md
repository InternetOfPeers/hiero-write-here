# Hiero Message Box - Encrypted Asynchronous Messaging

Hiero Message Box is a simple way for users to set a message box where receive private messages, for example getting alert about security communications about their assets or wallet, etc.

The repo contains the code both for the sender and the receiver.

The goal is to enable users to send encrypted messages to an account's message box just like this:

`npm run send-message 0.0.xxx "This is a secret message for you"`

Users can check their messages like this

`npm run check-messages <STARTING_INDEX> # starts from the beginning`

They can also listen to new messages using this command:

`npm run listen-for-new-messages`

When trying to listen for the first time, the program will configure the account accordingly to the configuration.

To avoid spam, users can decide to set a paid topic as their message box.

## Features

- **RSA Encryption**: Automatically generates and manages RSA key pairs for message encryption/decryption
- **Hedera Topics**: Creates and manages Hedera topics for message distribution
- **Key Verification**: Automatically verifies local keys match the topic's public key
- **Mirror Node API**: Uses Hedera Mirror Node for reliable message polling and topic verification
- **Real-time Listening**: Continuously polls for new encrypted messages every 3 seconds
- **Modular Architecture**: Common functions extracted for reusability and maintainability
- **Minimal Dependencies**: Uses only Hashgraph SDK v2.76.0 and native Node.js functions

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

### Listen for Messages (Receiver)

Start the listener to receive encrypted messages:

```bash
npm start
# or
npm run listen
```

On first run, the application will:

1. Generate and save an RSA key pair in `data/` folder
2. Initialize Hedera client
3. Create a new Hedera topic
4. Publish your public key to the topic (as the first message)
5. Update your account memo with the topic ID (e.g., "Write here: 0.0.xxxxx")
6. Start listening for messages via Mirror Node API

#### Subsequent Runs

The application will:

- Load existing RSA keys from `data/` folder
- Check the account memo for the topic ID
- Verify the topic exists and has a public key message via Mirror Node API
- Verify local private key can decrypt messages encrypted with the topic's public key
  - If keys don't match: offer to create a new topic or exit
  - If everything is valid: start listening for messages

### Send Encrypted Messages (Sender)

Send an encrypted message to another account:

```bash
npm run send-message <account-id> <message>
# or
node send-message.js <account-id> <message>
```

**Example:**

```bash
npm run send 0.0.1441 "Hello, this is a secret message!"
```

#### How it works

1. Reads the target account's memo to find the topic ID
2. Retrieves the recipient's public key from the first message in the topic via Mirror Node API
3. Generates a random AES-256 key
4. Encrypts the message with AES (fast, suitable for large messages)
5. Encrypts the AES key with the recipient's RSA public key
6. Sends the encrypted payload to the topic

The recipient will automatically decrypt and display the message when polling.

## Project Flow

### Listener (Receiver)

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
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│ 7. Poll for Encrypted Messages      │
│    - Fetch via Mirror Node API      │
│    - Decrypt with hybrid AES+RSA    │
│    - Print to console               │
└─────────────────────────────────────┘
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
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│ 4. Get Public Key via Mirror Node   │
│    (from first message)             │
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
│ 8. Submit to Topic                  │
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

### Mirror Node API Usage

This application uses the Hedera Mirror Node API instead of direct gRPC subscriptions for improved reliability:

- **Topic Verification**: Checks if topics exist and validates their first message
- **Message Polling**: Polls for new messages every 3 seconds
- **Public Key Retrieval**: Fetches recipient public keys from topic's first message
- **Stateless Operation**: No local config files needed, all state verified live from the network

### Key Verification System

On startup, the listener performs cryptographic verification:

1. Fetches the public key from the topic (first message)
2. Encrypts a test message with the topic's public key
3. Attempts to decrypt it with the local private key
4. If successful: keys match, can decrypt incoming messages
5. If failed: prompts user to create a new topic or restore original keys

This prevents silent failures where messages appear to arrive but can't be decrypted.

## File Structure

```text
./
├── src/
│   ├── common.js                   # Common functions
│   ├── listen-for-new-messages.js  # Listener/Receiver application
│   └── send-message.js             # Sender application
├── data/
│   ├── rsa_private.pem             # RSA private key (auto-generated)
│   └── rsa_public.pem              # RSA public key (auto-generated)
├── package.json                    # Dependencies and scripts
├── .env                            # Hedera credentials (not committed)
├── .env.example                    # Example environment file
└── .gitignore                      # Git ignore rules
```

## Configuration Files

### RSA Keys (auto-generated)

- `data/rsa_private.pem`: Your private key for decryption
- `data/rsa_public.pem`: Your public key (shared in the topic)

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

- Ensure `.env` file exists and contains valid credentials

### "Topic creation failed"

- Verify your account has sufficient HBAR balance
- Check network connectivity

### "Cannot decrypt message"

- The message may be encrypted with a different public key
- Run the listener - it will detect the key mismatch and offer to create a new topic
- Alternatively, restore the original RSA keys to the `data/` folder

### "Key verification failed"

- Your local RSA keys don't match the public key in the topic
- This happens if keys were regenerated or replaced
- The listener will prompt you to create a new topic with the current keys

## License

MIT
