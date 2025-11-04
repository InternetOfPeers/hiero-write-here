# Write Here - Hedera Encrypted Messaging

A Node.js application that uses Hedera Hashgraph to create an encrypted messaging system via Hedera Consensus Service (HCS) topics.

## Features

- **RSA Encryption**: Automatically generates and manages RSA key pairs for message encryption/decryption
- **Hedera Topics**: Creates and manages Hedera topics for message distribution
- **State Management**: Persists configuration to avoid redundant operations on restart
- **Real-time Listening**: Continuously listens for new encrypted messages
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
HEDERA_ACCOUNT_ID=0.0.xxxxx
HEDERA_PRIVATE_KEY=302e020100300506032b657004220420...
```

## Usage

### Listen for Messages (Receiver)

Start the listener to receive encrypted messages:

```bash
npm start
# or
npm run listen
# or
node listen.js
```

#### First Run

On first run, the application will:

1. ✓ Generate and save an RSA key pair (`rsa_private.pem`, `rsa_public.pem`)
2. ✓ Initialize Hedera client
3. ✓ Create a new Hedera topic
4. ✓ Publish your public key to the topic
5. ✓ Update your account memo with the topic ID (e.g., "Write here: 0.0.xxxxx")
6. ✓ Start listening for messages

#### Subsequent Runs

The application will:

- Load existing RSA keys
- Check the account memo for the topic ID
- Verify the topic exists and has the public key message
- Skip setup steps if everything is correctly configured
- Continue listening for messages

### Send Encrypted Messages (Sender)

Send an encrypted message to another account:

```bash
npm run send <account-id> <message>
# or
node send.js <account-id> <message>
```

**Example:**

```bash
node send.js 0.0.1441 "Hello, this is a secret message!"
```

#### How it works

1. Reads the target account's memo to find the topic ID
2. Retrieves the recipient's public key from the first message in the topic
3. Generates a random AES-256 key
4. Encrypts the message with AES (fast, suitable for large messages)
5. Encrypts the AES key with the recipient's RSA public key
6. Sends the encrypted payload to the topic

The recipient will automatically decrypt and display the message.

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
│ 2. Fetch Account Memo               │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│ 3. Extract Topic ID from Memo       │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│ 4. Read First Message (Public Key)  │
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
│ 8. Send to Topic                    │
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

## File Structure

```text
./
├── src/
│   ├── common.js        # Common functions
│   ├── listen.js        # Listener/Receiver application
│   └── send.js          # Sender application
├── data/
│   ├── rsa_private.pem  # RSA private key (auto-generated)
│   └── rsa_public.pem   # RSA public key (auto-generated)
├── package.json         # Dependencies and scripts
├── .env                 # Hedera credentials (not committed)
├── .env.example         # Example environment file
└── .gitignore           # Git ignore rules
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

By default, the application uses **Hedera Testnet**. To switch to mainnet:

Edit `listen.js` and change:

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
