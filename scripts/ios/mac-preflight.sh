#!/bin/bash
# Read-only local preflight. Does not install, sign, trust certificates or reveal device identities.
set -eu
if [ "$(uname -s)" != "Darwin" ]; then
  echo "This preflight requires the user's own Mac. Windows/Linux syntax checks are not Mac validation." >&2
  exit 2
fi
echo "macOS: $(sw_vers -productVersion)"
echo "Architecture: $(uname -m)"
echo "Memory bytes: $(sysctl -n hw.memsize)"
for command in node git xcodebuild xcrun; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing tool: $command. Install/configure it locally before running the iOS sample." >&2
    exit 1
  fi
done
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major<22||(major===22&&minor<12)){console.error("Node >=22.12 is required");process.exit(1)} console.log("Node: "+process.version)'
git --version
xcodebuild -version
xcrun --find simctl >/dev/null
echo "Tool discovery passed. Signing, connected iPhone, simulator, native recording and backend still need separate verification."
