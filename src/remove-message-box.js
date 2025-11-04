const { initializeClient } = require("./lib/hedera");
const { loadEnvFile } = require("./lib/common");
const { removeMessageBox } = require("./lib/message-box");

let client = null;

async function main() {
  try {
    loadEnvFile();
    client = initializeClient();
    console.log(
      `⚙ Removing message box for account ${client.operatorAccountId}`,
    );
    await removeMessageBox(client, client.operatorAccountId);
    client.close();
    process.exit(0);
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
