#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this with sudo: sudo bash $0"
  exit 1
fi

TARGET_USER="${SUDO_USER:-${USER}}"
TARGET_HOME="$(getent passwd "${TARGET_USER}" | cut -d: -f6)"
SDK_ROOT="${TARGET_HOME}/Android/Sdk"
CMDLINE_ROOT="${SDK_ROOT}/cmdline-tools"
CMDLINE_LATEST="${CMDLINE_ROOT}/latest"
PROFILE_FILE="${TARGET_HOME}/.bashrc"
AVD_NAME="${AVD_NAME:-Pixel_8_API_latest}"
JDK_PKG="${JDK_PKG:-openjdk-17-jdk-headless}"

run_as_user() {
  sudo -u "${TARGET_USER}" -H bash -lc "$1"
}

echo "Installing OS packages..."
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  acl \
  curl \
  unzip \
  wget \
  ca-certificates \
  cpu-checker \
  qemu-kvm \
  libvirt-daemon-system \
  libvirt-clients \
  bridge-utils \
  libxcb-cursor0 \
  libx11-xcb1 \
  libxdamage1 \
  libnss3 \
  libxcomposite1 \
  libxcursor1 \
  libxi6 \
  libxtst6 \
  libxrandr2 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libdrm2 \
  libdbus-1-3 \
  libxkbcommon0 \
  libasound2t64 \
  libgbm1 \
  libgtk-3-0t64 \
  mesa-utils \
  adb \
  "${JDK_PKG}"

echo "Ensuring KVM/libvirt access for ${TARGET_USER}..."
usermod -aG kvm "${TARGET_USER}" || true
usermod -aG libvirt "${TARGET_USER}" || true

if [[ -e /dev/kvm ]]; then
  echo "Granting immediate /dev/kvm access to ${TARGET_USER} for this boot..."
  setfacl -m "u:${TARGET_USER}:rw" /dev/kvm || true
fi

mkdir -p "${CMDLINE_ROOT}"
chown -R "${TARGET_USER}:${TARGET_USER}" "${TARGET_HOME}/Android"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

REPO_XML="${TMP_DIR}/repository2-1.xml"
curl -fsSL "https://dl.google.com/android/repository/repository2-1.xml" -o "${REPO_XML}"

echo "Finding latest Android command-line tools package..."
CMDLINE_ZIP_REL="$(
  grep -oP '(?s)<remotePackage path="cmdline-tools;latest">.*?<url>\K[^<]+' "${REPO_XML}" | head -n1
)"
if [[ -z "${CMDLINE_ZIP_REL}" ]]; then
  echo "Failed to locate cmdline-tools package URL in Android repository metadata."
  exit 1
fi

CMDLINE_URL="https://dl.google.com/android/repository/${CMDLINE_ZIP_REL}"
CMDLINE_ZIP="${TMP_DIR}/cmdline-tools.zip"

echo "Downloading: ${CMDLINE_URL}"
curl -fsSL "${CMDLINE_URL}" -o "${CMDLINE_ZIP}"

rm -rf "${CMDLINE_LATEST}"
mkdir -p "${CMDLINE_LATEST}"
unzip -q "${CMDLINE_ZIP}" -d "${TMP_DIR}/cmdline-extract"

if [[ -d "${TMP_DIR}/cmdline-extract/cmdline-tools" ]]; then
  cp -a "${TMP_DIR}/cmdline-extract/cmdline-tools/." "${CMDLINE_LATEST}/"
else
  echo "Unexpected cmdline-tools archive layout."
  exit 1
fi

chown -R "${TARGET_USER}:${TARGET_USER}" "${TARGET_HOME}/Android"

ANDROID_ENV=$(cat <<EOF
export ANDROID_SDK_ROOT="${SDK_ROOT}"
export ANDROID_HOME="${SDK_ROOT}"
export PATH="\$PATH:${SDK_ROOT}/cmdline-tools/latest/bin:${SDK_ROOT}/platform-tools:${SDK_ROOT}/emulator"
EOF
)

if ! grep -q 'ANDROID_SDK_ROOT=' "${PROFILE_FILE}" 2>/dev/null; then
  {
    echo ""
    echo "# Android SDK"
    echo "${ANDROID_ENV}"
  } >> "${PROFILE_FILE}"
  chown "${TARGET_USER}:${TARGET_USER}" "${PROFILE_FILE}"
fi

echo "Accepting Android SDK licenses..."
run_as_user "
  export ANDROID_SDK_ROOT='${SDK_ROOT}'
  yes | '${CMDLINE_LATEST}/bin/sdkmanager' --licenses >/dev/null
"

echo "Installing platform tools, emulator, platform, and build tools..."
run_as_user "
  export ANDROID_SDK_ROOT='${SDK_ROOT}'
  '${CMDLINE_LATEST}/bin/sdkmanager' \
    'platform-tools' \
    'emulator' \
    'platforms;android-35' \
    'build-tools;35.0.0'
"

echo "Selecting latest available Google APIs x86_64 system image..."
LATEST_IMAGE="$(
  run_as_user "
    export ANDROID_SDK_ROOT='${SDK_ROOT}'
    '${CMDLINE_LATEST}/bin/sdkmanager' --list | \
      grep -oE 'system-images;android-[0-9]+;google_apis;x86_64' | \
      sort -V | tail -n1
  "
)"

if [[ -z "${LATEST_IMAGE}" ]]; then
  echo "No x86_64 Google APIs system image found."
  exit 1
fi

echo "Installing system image: ${LATEST_IMAGE}"
run_as_user "
  export ANDROID_SDK_ROOT='${SDK_ROOT}'
  '${CMDLINE_LATEST}/bin/sdkmanager' '${LATEST_IMAGE}'
"

if run_as_user "test -d '${TARGET_HOME}/.android/avd/${AVD_NAME}.avd'"; then
  echo "AVD ${AVD_NAME} already exists, skipping creation."
else
  echo "Creating AVD ${AVD_NAME}..."
  run_as_user "
    export ANDROID_SDK_ROOT='${SDK_ROOT}'
    printf 'no\n' | '${CMDLINE_LATEST}/bin/avdmanager' create avd \
      -n '${AVD_NAME}' \
      -k '${LATEST_IMAGE}' \
      -d 'pixel_8'
  "
fi

LAUNCHER="${TARGET_HOME}/bin/start-terminal-android-emulator"
mkdir -p "$(dirname "${LAUNCHER}")"
cat > "${LAUNCHER}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export ANDROID_SDK_ROOT="${SDK_ROOT}"
export ANDROID_HOME="${SDK_ROOT}"
export PATH="\$PATH:${SDK_ROOT}/cmdline-tools/latest/bin:${SDK_ROOT}/platform-tools:${SDK_ROOT}/emulator"
EMULATOR_CMD="${SDK_ROOT}/emulator/emulator -avd ${AVD_NAME} -gpu swiftshader_indirect"
if command -v sg >/dev/null 2>&1 && getent group kvm | grep -Eq "(^|:|,)\${USER}(,|$)"; then
  exec sg kvm -c "\${EMULATOR_CMD} \$(printf '%q ' "\$@")"
fi
exec "${SDK_ROOT}/emulator/emulator" -avd "${AVD_NAME}" -gpu swiftshader_indirect "\$@"
EOF
chown "${TARGET_USER}:${TARGET_USER}" "${LAUNCHER}"
chmod +x "${LAUNCHER}"

echo
echo "Checking emulator acceleration..."
run_as_user "
  export ANDROID_SDK_ROOT='${SDK_ROOT}'
  '${SDK_ROOT}/emulator/emulator' -accel-check || true
"

cat <<EOF

Install complete.

Run the emulator as your normal user with:
  ${LAUNCHER}

Inside the emulator, browse to:
  http://10.0.2.2:3002

If KVM group membership is not active yet, a logout/login will improve performance,
but the launcher is ready now and temporary /dev/kvm access was attempted.
EOF
