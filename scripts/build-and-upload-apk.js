#!/usr/bin/env node
/**
 * build-and-upload-apk.js
 *
 * Yeh script:
 * 1. installment-customer APK build karta hai (release)
 * 2. APK signing certificate ka SHA-256 checksum nikalta hai
 * 3. APK ko Supabase Storage mein upload karta hai
 * 4. .env files update karta hai (TestingInstallment + installment-customer)
 *
 * Usage:
 *   node scripts/build-and-upload-apk.js
 *
 * Prerequisites:
 *   - installment-customer/.env mein Supabase credentials hone chahiye
 *   - Android SDK + Java installed hona chahiye
 *   - 'expo' aur '@supabase/supabase-js' installed hone chahiye
 */

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const https = require('https');
const http = require('http');

// ── Config ─────────────────────────────────────────────────────────────────
const CUSTOMER_PROJECT = path.resolve(__dirname, '..');
const OWNER_PROJECT = path.resolve(__dirname, '../../TestingInstallment');
const APK_BUCKET = 'apks';
const APK_FILENAME = 'installment-customer.apk';

// Load .env from installment-customer
function loadEnv(projectPath) {
  const envPath = path.join(projectPath, '.env');
  if (!fs.existsSync(envPath)) return {};
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) env[m[1].trim()] = m[2].trim();
  }
  return env;
}

function updateEnvFile(filePath, updates) {
  let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content = content.trimEnd() + `\n${key}=${value}\n`;
    }
  }
  fs.writeFileSync(filePath, content);
  console.log(`✅ Updated: ${filePath}`);
}

// ── Step 1: Find or Build APK ───────────────────────────────────────────────
function findApk() {
  const candidates = [
    path.join(CUSTOMER_PROJECT, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
    path.join(CUSTOMER_PROJECT, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function buildApk() {
  console.log('\n📦 Building release APK...');
  console.log('   (This may take 5-10 minutes on first build)\n');
  const result = spawnSync(
    'bash',
    [
      '-c',
      'CI=1 npx expo prebuild --platform android --clean && cd android && ./gradlew --refresh-dependencies -PreactNativeArchitectures=arm64-v8a -Pandroid.enableMinifyInReleaseBuilds=true -Pandroid.enableShrinkResourcesInReleaseBuilds=true -Pandroid.enableBundleCompression=true assembleRelease',
    ],
    {
      cwd: CUSTOMER_PROJECT,
      stdio: 'inherit',
      env: { ...process.env },
    }
  );
  if (result.status !== 0) {
    console.error('❌ APK build failed!');
    process.exit(1);
  }
}

// ── Step 2: Get APK SHA-256 Package Checksum ────────────────────────────────
function getPackageChecksum(apkPath) {
  console.log('\n🔑 Calculating APK package checksum...');
  const apkBytes = fs.readFileSync(apkPath);
  const b64 = crypto.createHash('sha256').update(apkBytes).digest('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

// ── Step 3: Upload APK to Supabase Storage ──────────────────────────────────
async function uploadToSupabase(apkPath, supabaseUrl, supabaseKey) {
  console.log(`\n☁️  Uploading APK to Supabase Storage bucket: "${APK_BUCKET}"...`);

  const apkBytes = fs.readFileSync(apkPath);
  const uploadUrl = `${supabaseUrl}/storage/v1/object/${APK_BUCKET}/${APK_FILENAME}`;
  const publicUrl = `${supabaseUrl}/storage/v1/object/public/${APK_BUCKET}/${APK_FILENAME}`;

  return new Promise((resolve, reject) => {
    const urlObj = new URL(uploadUrl);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Length': apkBytes.length,
        'x-upsert': 'true', // overwrite existing file
        'Cache-Control': '3600',
      },
    };

    const req = (urlObj.protocol === 'https:' ? https : http).request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          console.log(`✅ Uploaded! Public URL:\n   ${publicUrl}`);
          resolve(publicUrl);
        } else {
          // Try upsert (update) instead
          console.log(`   POST returned ${res.statusCode}, trying PUT (upsert)...`);
          uploadWithPut(apkBytes, supabaseUrl, supabaseKey, publicUrl, resolve, reject);
        }
      });
    });

    req.on('error', reject);
    req.write(apkBytes);
    req.end();
  });
}

function uploadWithPut(apkBytes, supabaseUrl, supabaseKey, publicUrl, resolve, reject) {
  const uploadUrl = `${supabaseUrl}/storage/v1/object/${APK_BUCKET}/${APK_FILENAME}`;
  const urlObj = new URL(uploadUrl);
  const options = {
    hostname: urlObj.hostname,
    port: urlObj.port || 443,
    path: urlObj.pathname,
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': apkBytes.length,
      'x-upsert': 'true',
    },
  };

  const req = (urlObj.protocol === 'https:' ? https : http).request(options, (res) => {
    let body = '';
    res.on('data', (chunk) => (body += chunk));
    res.on('end', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        console.log(`✅ Uploaded (PUT)! Public URL:\n   ${publicUrl}`);
        resolve(publicUrl);
      } else {
        reject(new Error(`Upload failed: HTTP ${res.statusCode} — ${body}`));
      }
    });
  });

  req.on('error', reject);
  req.write(apkBytes);
  req.end();
}

// ── Step 4: Ensure Bucket Exists ────────────────────────────────────────────
async function ensureBucketExists(supabaseUrl, supabaseKey) {
  console.log(`\n🪣  Ensuring Supabase Storage bucket "${APK_BUCKET}" exists...`);

  const createUrl = `${supabaseUrl}/storage/v1/bucket`;
  const body = JSON.stringify({ id: APK_BUCKET, name: APK_BUCKET, public: true });
  const urlObj = new URL(createUrl);

  return new Promise((resolve) => {
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = (urlObj.protocol === 'https:' ? https : http).request(options, (res) => {
      let resp = '';
      res.on('data', (chunk) => (resp += chunk));
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          console.log(`✅ Bucket "${APK_BUCKET}" created (public).`);
        } else if (res.statusCode === 400 && resp.includes('already exists')) {
          console.log(`ℹ️  Bucket "${APK_BUCKET}" already exists.`);
        } else {
          console.warn(`⚠️  Bucket creation returned ${res.statusCode}: ${resp}`);
        }
        resolve();
      });
    });

    req.on('error', () => resolve()); // bucket might already exist
    req.write(body);
    req.end();
  });
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   Installment Customer — APK Build & Upload      ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  // Load env
  const env = loadEnv(CUSTOMER_PROJECT);
  const supabaseUrl = env['EXPO_PUBLIC_SUPABASE_URL'];
  const supabaseKey = env['EXPO_PUBLIC_SUPABASE_ANON_KEY'];

  if (!supabaseUrl || !supabaseKey) {
    console.error('❌ EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY must be set in installment-customer/.env');
    process.exit(1);
  }

  // Step 1: Find or build APK
  let apkPath = findApk();
  if (apkPath) {
    const sizeMb = fs.statSync(apkPath).size / 1024 / 1024;
    const shouldRebuild = process.argv.some(arg => arg === '--rebuild' || arg === 'rebuild' || arg === '-r');
    if (sizeMb > 45 || shouldRebuild) {
      console.log(`ℹ️  Existing APK is ${sizeMb.toFixed(1)} MB (>45MB). Deleting to build optimized APK...`);
      try { fs.unlinkSync(apkPath); } catch {}
      apkPath = null;
    }
  }

  if (apkPath) {
    console.log(`✅ Found existing APK:\n   ${apkPath}`);
  } else {
    buildApk();
    apkPath = findApk();
    if (!apkPath) {
      console.error('❌ APK build succeeded but file not found.');
      process.exit(1);
    }
  }

  const apkSize = (fs.statSync(apkPath).size / 1024 / 1024).toFixed(1);
  console.log(`📱 APK size: ${apkSize} MB`);

  // Step 2: Get checksum
  const checksum = getPackageChecksum(apkPath);
  console.log(`✅ Package checksum:\n   ${checksum}`);

  // Step 3: Create bucket + upload
  await ensureBucketExists(supabaseUrl, supabaseKey);
  const publicUrl = await uploadToSupabase(apkPath, supabaseUrl, supabaseKey);

  // Step 4: Update .env files
  console.log('\n📝 Updating .env files...');
  const updates = {
    EXPO_PUBLIC_APK_URL: publicUrl,
    EXPO_PUBLIC_APK_CHECKSUM: checksum,
  };

  // Update installment-customer/.env (for reference / future builds)
  updateEnvFile(path.join(CUSTOMER_PROJECT, '.env'), updates);

  // Update TestingInstallment/.env (so the provisioning QR is correct)
  updateEnvFile(path.join(OWNER_PROJECT, '.env'), updates);

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   ✅ Done! Provisioning QR is ready to use.      ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
  console.log(`APK URL:    ${publicUrl}`);
  console.log(`Checksum:   ${checksum}`);
  console.log('\nTestingInstallment app restart karo — provisioning QR\nautomatically update ho jayega.\n');
}

main().catch((e) => {
  console.error('❌ Fatal error:', e.message || e);
  process.exit(1);
});
