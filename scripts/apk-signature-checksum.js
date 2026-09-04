#!/usr/bin/env node
/**
 * Prints Android Enterprise PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM
 * for a signed APK (URL-safe base64 SHA-256 of the signing certificate).
 *
 * Usage:
 *   node scripts/apk-signature-checksum.js path/to/app-release.apk
 */
const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const apk = process.argv[2];
if (!apk || !fs.existsSync(apk)) {
  console.error('Usage: node scripts/apk-signature-checksum.js <app-release.apk>');
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-cert-'));
try {
  execSync(`unzip -o -q "${apk}" "META-INF/*" -d "${tmp}"`, { stdio: 'pipe' });
  const meta = path.join(tmp, 'META-INF');
  const files = fs.existsSync(meta) ? fs.readdirSync(meta) : [];
  const sig = files.find((f) => /\.(RSA|DSA|EC)$/i.test(f));
  if (!sig) {
    console.error(
      'No META-INF/*.RSA cert found (v2/v3-only APK?). Export cert from your keystore:\n' +
        '  keytool -exportcert -keystore <keystore> -alias <alias> -file cert.der\n' +
        '  node -e "const c=require(\'crypto\'),fs=require(\'fs\');' +
        'const b=c.createHash(\'sha256\').update(fs.readFileSync(\'cert.der\')).digest(\'base64\');' +
        'console.log(b.replace(/\\\\+/g,\'-\').replace(/\\\\//g,\'_\').replace(/=+$/,\'\'))"'
    );
    process.exit(2);
  }

  const sigPath = path.join(meta, sig);
  const pemPath = path.join(tmp, 'cert.pem');
  const derPath = path.join(tmp, 'cert.der');
  execSync(`openssl pkcs7 -inform DER -in "${sigPath}" -print_certs -out "${pemPath}"`, {
    stdio: 'pipe',
  });
  execSync(`openssl x509 -in "${pemPath}" -outform DER -out "${derPath}"`, { stdio: 'pipe' });

  const der = fs.readFileSync(derPath);
  const b64 = crypto.createHash('sha256').update(der).digest('base64');
  const checksum = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

  console.log(checksum);
  console.error('\nAdd to TestingInstallment .env:');
  console.error(`EXPO_PUBLIC_CUSTOMER_APK_SIGNATURE_CHECKSUM=${checksum}`);
  console.error('EXPO_PUBLIC_CUSTOMER_APK_URL=https://YOUR_HOST/app-release.apk');
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
