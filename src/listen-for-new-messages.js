const { initializeClient } = require("./lib/hedera");
const { loadEnvFile } = require("./lib/common");
const { pollMessages } = require("./lib/message-box");

let client = null;

async function main() {
  try {
    loadEnvFile();
    client = initializeClient();
    accountId = client.operatorAccountId;
    console.log(`⚙ Listening for messages for account ${accountId}`);
    console.log("✓ Polling every 3 seconds. Press Ctrl+C to exit\n");
    while (true) {
      await pollMessages(client, process.env.DATA_DIR, accountId).then(
        (messages) => {
          if (messages.length > 0)
            console.log(`${messages.length} new message(s) received`);
          messages.forEach((message) => {
            console.log(`📥`, message);
          });
          return new Promise((resolve) => setTimeout(resolve, 3000));
        }
      );
    }
  } catch (error) {
    console.error("\n✗ Error:", error.message);
    if (client) client.close();
    process.exit(1);
  }
}

// Handle Ctrl+C gracefully
process.on("SIGINT", () => {
  console.log("\n\n⚙ Shutting down...");
  if (client) client.close();
  process.exit(0);
});

main();
