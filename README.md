# Write Here - Hedera Encrypted Messaging

A Node.js application that uses Hedera Hashgraph to create an encrypted messaging system via Hedera Consensus Service (HCS) topics.

## Features

- **RSA Encryption**: Automatically generates and manages RSA key pairs for message encryption/decryption
- **Hedera Topics**: Creates and manages Hedera topics for message distribution
- **State Management**: Persists configuration to avoid redundant operations on restart
- **Real-time Listening**: Continuously listens for new encrypted messages
- **Minimal Dependencies**: Uses only Hashgraph SDK and native Node.js functions

## Prerequisites

- Node.js (v14 or higher)
- A Hedera testnet or mainnet account
  - Get a free testnet account at: https://portal.hedera.com/register

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
```
HEDERA_ACCOUNT_ID=0.0.xxxxx
HEDERA_PRIVATE_KEY=302e020100300506032b657004220420...
```

## Usage

### Start the Application

```bash
npm start
```

### First Run

On first run, the application will:
1. ✓ Generate and save an RSA key pair (`rsa_private.pem`, `rsa_public.pem`)
2. ✓ Initialize Hedera client
3. ✓ Create a new Hedera topic
4. ✓ Publish your public key to the topic
5. ✓ Update your account memo with the topic ID
6. ✓ Start listening for messages

### Subsequent Runs

The application will:
- Load existing RSA keys
- Use the existing topic
- Skip already-completed setup steps
- Continue listening for messages

## Project Flow

```
┌─────────────────────────────────────┐
│ 1. Load/Generate RSA Keys           │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│ 2. Initialize Hedera Client         │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│ 3. Create Topic (if needed)         │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│ 4. Publish Public Key (if needed)   │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│ 5. Update Account Memo (if needed)  │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│ 6. Listen for Encrypted Messages    │
│    - Decrypt with RSA private key   │
│    - Print to console               │
└─────────────────────────────────────┘
```

## Sending Messages to Your Topic

To send encrypted messages to your topic, use the companion sender script or create your own:

```javascript
const crypto = require('crypto');
const { Client, TopicMessageSubmitTransaction } = require('@hashgraph/sdk');

// Encrypt message with your public key
const publicKey = '...'; // Your RSA public key
const message = 'Hello, World!';

const encrypted = crypto.publicEncrypt(
  {
    key: publicKey,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256'
  },
  Buffer.from(message)
);

const payload = JSON.stringify({
  type: 'ENCRYPTED_MESSAGE',
  data: encrypted.toString('base64')
});

// Submit to topic
const transaction = new TopicMessageSubmitTransaction({
  topicId: '0.0.xxxxx',
  message: payload
});

await transaction.execute(client);
```

## File Structure

```
write-here/
├── index.js              # Main application
├── package.json          # Dependencies and scripts
├── .env                  # Hedera credentials (not committed)
├── .env.example          # Example environment file
├── .gitignore           # Git ignore rules
├── config.json          # Runtime configuration (auto-generated)
├── rsa_private.pem      # RSA private key (auto-generated)
└── rsa_public.pem       # RSA public key (auto-generated)
```

## Configuration Files

### `config.json` (auto-generated)
Stores runtime state:
```json
{
  "topicId": "0.0.xxxxx",
  "publicKeyPublished": true,
  "memoUpdated": true
}
```

### RSA Keys (auto-generated)
- `rsa_private.pem`: Your private key for decryption
- `rsa_public.pem`: Your public key (shared in the topic)

## Security Notes

- Never commit your `.env` file or RSA private key
- The private key is only used locally for decryption
- The public key is published to the topic for others to encrypt messages
- Keep your Hedera private key secure

## Network Configuration

By default, the application uses **Hedera Testnet**. To switch to mainnet:

Edit `index.js` and change:
```javascript
client = Client.forTestnet();
```
to:
```javascript
client = Client.forMainnet();
```

## Troubleshooting

### "Please set HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY"
- Ensure `.env` file exists and contains valid credentials

### "Topic creation failed"
- Verify your account has sufficient HBAR balance
- Check network connectivity

### "Cannot decrypt message"
- The message may be encrypted with a different public key
- Ensure you're using the correct private key

## License

MIT
