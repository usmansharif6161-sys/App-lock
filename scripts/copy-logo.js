const fs = require('fs');
const path = require('path');

const imgDir = path.join(__dirname, '..', 'assets', 'images');
const customerPath = path.join(imgDir, 'customer.png');
const iconPath = path.join(imgDir, 'icon.png');

try {
  fs.copyFileSync(customerPath, iconPath);
  console.log('Successfully updated customer icon.png');
} catch (err) {
  console.error('Error copying customer image:', err);
}
