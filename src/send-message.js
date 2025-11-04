const { initializeClient } = require("./lib/hedera");
const { loadEnvFile } = require("./lib/common");
const { sendMessage } = require("./lib/message-box");

let client = null;

async function main() {
  try {
    loadEnvFile();
    client = initializeClient();
    if (process.argv.length < 4) {
      console.error("\n✗ Usage: node send-message.js <account-id> <message>");
      console.error('✓ Example: node send-message.js 0.0.1234 "Hello!"\n');
      process.exit(1);
    }
    const recipientAccountId = process.argv[2];
    const message = process.argv.slice(3).join(" ");
    console.log(
      `⚙ Sending message:\n  - Recipient: ${recipientAccountId} \n  - Message before encryption: "${message}"`,
    );
    await sendMessage(client, recipientAccountId, message);
    client.close();
    process.exit(0);
  } catch (error) {
    console.error("\n✗ Error:", error.message);
    if (client) client.close();
    process.exit(1);
  }
}

process.on("SIGINT", () => {
  console.log("\n\n⚙ Shutting down...");
  if (client) client.close();
  process.exit(0);
});

main();
