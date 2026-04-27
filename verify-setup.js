#!/usr/bin/env node

/**
 * Verify Setup Script
 * 
 * Checks if all required dependencies and services are available
 * Run this before running integration tests
 */

const fs = require('fs');
const path = require('path');

console.log('='.repeat(60));
console.log('Realtime Analytics Dashboard — Setup Verification');
console.log('='.repeat(60));

let allGood = true;

// Check 1: Node.js version
console.log('\n[1] Node.js Version');
const nodeVersion = process.version;
console.log(`    ✓ Node.js ${nodeVersion}`);
if (parseInt(nodeVersion.split('.')[0].substring(1)) < 18) {
  console.log('    ✗ ERROR: Node.js >= 18 required');
  allGood = false;
}

// Check 2: Required directories
console.log('\n[2] Project Structure');
const requiredDirs = [
  'service-a',
  'websocket-gateway',
  'event-processor',
  'frontend',
  'tests/integration',
  'tests/load'
];

requiredDirs.forEach(dir => {
  if (fs.existsSync(dir)) {
    console.log(`    ✓ ${dir}/`);
  } else {
    console.log(`    ✗ ${dir}/ NOT FOUND`);
    allGood = false;
  }
});

// Check 3: Required files
console.log('\n[3] Required Files');
const requiredFiles = [
  'tests/integration/e2e-local.js',
  'tests/load/load-test.yml',
  'tests/load/load-test-processor.js',
  'TESTING_GUIDE.md',
  'tests/README.md',
  'INTEGRATION_TESTS_SETUP.md',
  'LAURA_CHECKLIST.md'
];

requiredFiles.forEach(file => {
  if (fs.existsSync(file)) {
    console.log(`    ✓ ${file}`);
  } else {
    console.log(`    ✗ ${file} NOT FOUND`);
    allGood = false;
  }
});

// Check 4: Service A setup
console.log('\n[4] Service A');
if (fs.existsSync('service-a/package.json')) {
  const pkg = JSON.parse(fs.readFileSync('service-a/package.json', 'utf8'));
  if (pkg.dependencies && pkg.dependencies['@aws-sdk/client-sqs']) {
    console.log('    ✓ SQS SDK installed');
  } else {
    console.log('    ✗ SQS SDK not found in dependencies');
    allGood = false;
  }
  
  if (fs.existsSync('service-a/src/plugins/sqs.ts')) {
    console.log('    ✓ SQS plugin exists');
  } else {
    console.log('    ✗ SQS plugin not found');
    allGood = false;
  }
} else {
  console.log('    ✗ Service A package.json not found');
  allGood = false;
}

// Check 5: WebSocket Gateway setup
console.log('\n[5] WebSocket Gateway');
if (fs.existsSync('websocket-gateway/package.json')) {
  const pkg = JSON.parse(fs.readFileSync('websocket-gateway/package.json', 'utf8'));
  if (pkg.dependencies && pkg.dependencies['ws']) {
    console.log('    ✓ WebSocket library (ws) installed');
  } else {
    console.log('    ✗ WebSocket library not found');
    allGood = false;
  }
  
  if (pkg.dependencies && pkg.dependencies['express']) {
    console.log('    ✓ Express installed');
  } else {
    console.log('    ✗ Express not found');
    allGood = false;
  }
} else {
  console.log('    ✗ WebSocket Gateway package.json not found');
  allGood = false;
}

// Check 6: Frontend files
console.log('\n[6] Frontend Files');
const frontendFiles = [
  'frontend/index.html',
  'frontend/app.js',
  'frontend/dashboard.js',
  'frontend/latencyChart.js'
];

frontendFiles.forEach(file => {
  if (fs.existsSync(file)) {
    console.log(`    ✓ ${file}`);
  } else {
    console.log(`    ✗ ${file} NOT FOUND`);
    allGood = false;
  }
});

// Check 7: Environment files
console.log('\n[7] Environment Configuration');
const envFiles = [
  'service-a/.env',
  'websocket-gateway/.env'
];

envFiles.forEach(file => {
  if (fs.existsSync(file)) {
    console.log(`    ✓ ${file}`);
  } else {
    console.log(`    ⚠ ${file} NOT FOUND (will need to create)`);
  }
});

// Summary
console.log('\n' + '='.repeat(60));
if (allGood) {
  console.log('✓ Setup verification PASSED');
  console.log('\nNext steps:');
  console.log('1. Start Service A:        cd service-a && npm run dev');
  console.log('2. Start Gateway:          cd websocket-gateway && npm run dev');
  console.log('3. Run integration tests:  node tests/integration/e2e-local.js');
  console.log('\nFor detailed instructions, see TESTING_GUIDE.md');
} else {
  console.log('✗ Setup verification FAILED');
  console.log('\nPlease fix the issues above and try again.');
}
console.log('='.repeat(60));

process.exit(allGood ? 0 : 1);
