#!/usr/bin/env bash
# Set Installment Customer as Android Device Owner (shop phone only).
# WARNING: Requires factory-reset phone. Do not use on personal phones with data.

set -euo pipefail

PACKAGE="com.installment.customer"
RECEIVER="com.installment.customer/.DeviceAdminReceiver"

echo "Checking adb device..."
adb get-state >/dev/null

echo "Installing / verifying package: $PACKAGE"
adb shell pm path "$PACKAGE" >/dev/null

echo "Setting Device Owner..."
adb shell dpm set-device-owner "$RECEIVER"

echo "Done."
echo "Verify with:"
echo "  adb shell dumpsys device_policy | grep -A2 DeviceOwner"
echo ""
echo "Now open the customer app, open an installment, and tap Lock from owner app."
