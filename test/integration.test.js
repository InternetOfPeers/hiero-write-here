/**
 * Integration tests for hiero-message-box
 * Tests the main flows: setup, send, check, and remove message boxes
 *
 * Prerequisites:
 * - Set up .env file with test account credentials
 * - Ensure sufficient HBAR balance for transactions
 *
 * Run with: node test/integration.test.js
 */

const { initializeClient } = require('../src/lib/hedera');
const { loadEnvFile } = require('../src/lib/crypto');
const {
  setupMessageBox,
  sendMessage,
  checkMessages,
  removeMessageBox,
} = require('../src/lib/message-box');

// Test utilities
const assert = (condition, message) => {
  if (!condition) {
    throw new Error(`❌ Assertion failed: ${message}`);
  }
};

const testPassed = testName => {
  console.log(`✅ ${testName}`);
};

const testFailed = (testName, error) => {
  console.error(`❌ ${testName}: ${error.message}`);
  process.exit(1);
};

let client = null;
let testAccountId = null;
let messageBoxId = null;

// == Test Suite ==============================================================

async function testSetupMessageBox() {
  const testName = 'Setup Message Box';
  try {
    console.log(`\n🧪 Testing: ${testName}`);

    const result = await setupMessageBox(
      client,
      process.env.RSA_DATA_DIR || './data',
      testAccountId,
      { skipPrompts: true }
    );

    assert(result.success, 'Setup should succeed');
    assert(result.messageBoxId, 'Should return message box ID');

    messageBoxId = result.messageBoxId;

    // Wait for account memo to propagate to Mirror Node
    console.log('   Waiting for consensus (5s)...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    testPassed(testName);
  } catch (error) {
    testFailed(testName, error);
  }
}

async function testSendMessage() {
  const testName = 'Send Message';
  try {
    console.log(`\n🧪 Testing: ${testName}`);

    const testMessage = `Test message at ${Date.now()}`;

    await sendMessage(client, testAccountId, testMessage, { useCBOR: false });

    // Give time for consensus
    await new Promise(resolve => setTimeout(resolve, 3000));

    testPassed(testName);
  } catch (error) {
    testFailed(testName, error);
  }
}

async function testSendMessageCBOR() {
  const testName = 'Send Message (CBOR)';
  try {
    console.log(`\n🧪 Testing: ${testName}`);

    const testMessage = `CBOR test message at ${Date.now()}`;

    await sendMessage(client, testAccountId, testMessage, { useCBOR: true });

    // Give time for consensus
    await new Promise(resolve => setTimeout(resolve, 3000));

    testPassed(testName);
  } catch (error) {
    testFailed(testName, error);
  }
}

async function testCheckMessages() {
  const testName = 'Check Messages';
  try {
    console.log(`\n🧪 Testing: ${testName}`);

    const messages = await checkMessages(
      process.env.RSA_DATA_DIR || './data',
      testAccountId,
      2, // Start from sequence 2 (skip public key message)
      undefined // Get all messages
    );

    assert(Array.isArray(messages), 'Should return array of messages');
    assert(messages.length >= 2, 'Should have at least 2 test messages');

    // Verify messages contain expected content
    const hasTestMessage = messages.some(msg =>
      msg.includes('Test message at')
    );
    const hasCBORMessage = messages.some(msg =>
      msg.includes('CBOR test message at')
    );

    assert(hasTestMessage, 'Should find JSON test message');
    assert(hasCBORMessage, 'Should find CBOR test message');

    console.log(`   Found ${messages.length} message(s)`);
    testPassed(testName);
  } catch (error) {
    testFailed(testName, error);
  }
}

async function testMessageBoxReuse() {
  const testName = 'Message Box Reuse (Idempotency)';
  try {
    console.log(`\n🧪 Testing: ${testName}`);

    // Setup again should recognize existing message box
    const result = await setupMessageBox(
      client,
      process.env.RSA_DATA_DIR || './data',
      testAccountId,
      { skipPrompts: true }
    );

    assert(result.success, 'Second setup should succeed');
    assert(
      result.messageBoxId === messageBoxId,
      'Should return same message box ID'
    );

    testPassed(testName);
  } catch (error) {
    testFailed(testName, error);
  }
}

async function testSignatureVerification() {
  const testName = 'Signature Verification';
  try {
    console.log(`\n🧪 Testing: ${testName}`);

    // Sending a message implicitly tests signature verification
    // If verification fails, sendMessage will throw
    const testMessage = 'Signature verification test';

    await sendMessage(client, testAccountId, testMessage);

    testPassed(testName);
  } catch (error) {
    testFailed(testName, error);
  }
}

async function testRemoveMessageBox() {
  const testName = 'Remove Message Box';
  try {
    console.log(`\n🧪 Testing: ${testName}`);

    const result = await removeMessageBox(client, testAccountId);

    assert(result.success, 'Remove should succeed');

    // Give time for consensus
    await new Promise(resolve => setTimeout(resolve, 3000));

    testPassed(testName);
  } catch (error) {
    testFailed(testName, error);
  }
}

// == Main Test Runner ========================================================

async function runTests() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  HIERO MESSAGE BOX - INTEGRATION TESTS');
  console.log('═══════════════════════════════════════════════════════');

  try {
    // Initialize
    loadEnvFile();
    client = initializeClient();

    testAccountId = process.env.MESSAGE_BOX_OWNER_ACCOUNT_ID;
    if (!testAccountId) {
      throw new Error('MESSAGE_BOX_OWNER_ACCOUNT_ID not set in .env');
    }

    console.log(`\n📋 Test Account: ${testAccountId}`);
    console.log(`📋 Network: ${process.env.HEDERA_NETWORK || 'testnet'}`);

    // Run tests in sequence
    await testSetupMessageBox();
    await testSendMessage();
    await testSendMessageCBOR();
    await testCheckMessages();
    await testMessageBoxReuse();
    await testSignatureVerification();
    await testRemoveMessageBox();

    console.log('\n═══════════════════════════════════════════════════════');
    console.log('  ✅ ALL TESTS PASSED');
    console.log('═══════════════════════════════════════════════════════\n');

    client.close();
    process.exit(0);
  } catch (error) {
    console.error('\n❌ TEST SUITE FAILED:', error.message);
    if (client) client.close();
    process.exit(1);
  }
}

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log('\n\n⚙ Test interrupted...');
  if (client) client.close();
  process.exit(1);
});

// Run tests
runTests();
