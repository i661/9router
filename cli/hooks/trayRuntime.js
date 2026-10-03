// Lazy install systray2 for macOS/Linux into USER_DATA_DIR/runtime/node_modules.
// Windows uses PowerShell NotifyIcon (no binary) → no systray needed.
// This keeps the published npm tarball free of unsigned Go binaries that
// trigger antivirus false positives (e.g. Kaspersky flagging tray_windows.exe).
//
// We use the maintained `systray2` fork. The original `systray@1.0.5` package
// bundles a 2017 x86_64 Go binary whose Mach-O headers are rejected by modern
// dyld (macOS 14+), so it fails to load at all.
//
// Note that systray2 is NOT an Apple Silicon fix: like its predecessor it ships
// only an x86_64 `tray_darwin_release`, and picks it by process.platform with no
// process.arch branch, so there is no native slice to select. On arm64 macOS the
// tray therefore needs Rosetta 2 and dies with EBADARCH without it. We overlay
// our own arm64 build of the same upstream source on top — see ensureArm64TrayBin.
const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { getRuntimeDir, getRuntimeNodeModules, runNpmInstall, summarizeNpmError } = require("./sqliteRuntime");

const SYSTRAY_PKG = "systray2";
const SYSTRAY_VERSION = "2.1.4";
const LEGACY_SYSTRAY_PKG = "systray";

// Pinned `tray-binaries` release rather than `latest`, so the URL is stable and
// the artifact can only change by a deliberate re-upload. The workflow's publish
// step re-derives this repo from the literal below and refuses to upload
// anywhere else, so the integrity gate can't drift from what clients fetch.
//
// The asset is built by .github/workflows/tray-binaries.yml on a macos-15 runner.
// cgo compiles AppKit against the runner's SDK, so this value tracks that image:
// when GitHub updates it the sha changes, the workflow refuses to publish, and
// this constant must be bumped in the same change as the re-upload.
const ARM64_TRAY_URL = "https://github.com/decolua/9router/releases/download/tray-binaries/tray_darwin_arm64";
const ARM64_TRAY_SHA256 = "487e3c365aaa1eb6ad295bf3989711e975b52cee07505bf641c8559954881c81";
const ARM64_RETRY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function hasSystray() {
  return fs.existsSync(path.join(getRuntimeNodeModules(), SYSTRAY_PKG, "package.json"));
}

// Remove the legacy `systray` package from all known locations.
// On Windows it was an AV false-positive risk; on macOS/Linux its bundled
// binary is broken on modern OS versions.
function cleanupLegacySystray({ silent = false } = {}) {
  // 1) Runtime dir: ~/.9router/runtime/node_modules/systray (or %APPDATA% on Win)
  // 2) npm global nested: <npm_prefix>/node_modules/9router/node_modules/systray
  //    __dirname here = <pkg root>/hooks → up 1 = pkg root
  const targets = [
    path.join(getRuntimeNodeModules(), LEGACY_SYSTRAY_PKG),
    path.join(__dirname, "..", "node_modules", LEGACY_SYSTRAY_PKG)
  ];
  for (const dir of targets) {
    if (fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        if (!silent) console.log(`[9router][runtime] removed legacy systray: ${dir}`);
      } catch (e) {
        if (!silent) console.warn(`[9router][runtime] failed to remove ${dir}: ${e.message}`);
      }
    }
  }
}

// systray2's npm tarball sometimes ships the bundled Go binary without the
// executable bit set on macOS, causing spawn() to fail with EACCES. Set +x
// best-effort so the tray actually starts.
function chmodSystrayBin({ silent = false } = {}) {
  if (process.platform === "win32") return;
  const binName = process.platform === "darwin" ? "tray_darwin_release" : "tray_linux_release";
  const binPath = path.join(getRuntimeNodeModules(), SYSTRAY_PKG, "traybin", binName);
  if (!fs.existsSync(binPath)) return;
  try {
    fs.chmodSync(binPath, 0o755);
  } catch (e) {
    if (!silent) console.warn(`[9router][runtime] chmod tray bin failed: ${e.message}`);
  }
}

function ensureRuntimeDir() {
  const dir = getRuntimeDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, JSON.stringify({
      name: "9router-runtime",
      version: "1.0.0",
      private: true
    }, null, 2));
  }
  return dir;
}

// A thin (non-fat) 64-bit Mach-O stores its magic then cputype, both LE.
// CPU_TYPE_ARM64 is CPU_TYPE_ARM | CPU_ARCH_ABI64. Fat/universal binaries use a
// different magic and are reported as "not arm64" here, which is fine: we only
// ever overlay a thin arm64 build and only need to tell it apart from x86_64.
function isArm64MachO(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(8);
    fs.readSync(fd, buf, 0, 8, 0);
    if (buf.readUInt32LE(0) !== 0xfeedfacf) return false;
    return buf.readUInt32LE(4) === 0x0100000c;
  } catch {
    return false;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
  }
}

// Where systray2 actually executes from, with copyDir:true: node-systray copies
// the binary into ~/.cache/node-systray/<version>/ and index.js only re-copies
// from the package dir when that path is absent.
function systrayCopyCachePath() {
  return path.join(os.homedir(), ".cache", "node-systray", SYSTRAY_VERSION, "tray_darwin_release");
}

// Write our binary into that copy cache. Seeding — rather than clearing it and
// letting systray2 re-copy — is what makes the arm64 overlay survive a later
// re-extract of the x86_64 package: npm never touches files outside node_modules.
function seedSystrayCopyCache(srcBin, { silent = false } = {}) {
  const dest = systrayCopyCachePath();
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(srcBin, dest);
    fs.chmodSync(dest, 0o755);
    return true;
  } catch (e) {
    if (!silent) console.warn(`[9router][runtime] failed to seed tray copy cache: ${e.message}`);
    return false;
  }
}

// The runtime dir is installed into on demand (sqlite engine, tray), and npm
// prunes anything not listed in that dir's package.json. systray2 is installed
// with --no-save, so the next install removes it and re-extracts it from the
// registry — restoring the x86_64 binary and silently discarding the arm64
// overlay. Declaring the exact version keeps the package (and the overlay) in
// place across reinstalls and reboots.
function declareRuntimeDep(name, version) {
  try {
    const pkgPath = path.join(ensureRuntimeDir(), "package.json");
    const manifest = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    if (!manifest.dependencies) manifest.dependencies = {};
    if (manifest.dependencies[name] === version) return;
    manifest.dependencies[name] = version;
    fs.writeFileSync(pkgPath, JSON.stringify(manifest, null, 2) + "\n");
  } catch {
    // Best-effort: without the declaration the overlay still works, it just has
    // to be re-applied after every reinstall.
  }
}

function arm64AttemptMarker() {
  return path.join(getRuntimeDir(), ".tray-arm64-attempt");
}

// ensureTrayRuntime runs synchronously on every `9router` start (cli.js), so a
// failed download must not re-block the next launch. Retry at most daily.
function recentlyAttemptedArm64() {
  try {
    const at = Number(fs.readFileSync(arm64AttemptMarker(), "utf8").trim());
    return Number.isFinite(at) && Date.now() - at < ARM64_RETRY_COOLDOWN_MS;
  } catch {
    return false;
  }
}

function markArm64Attempt() {
  try { fs.writeFileSync(arm64AttemptMarker(), String(Date.now())); } catch {}
}

// Cleared on success so the cooldown only ever throttles *failures*. Without
// this, anything that restores systray2's x86_64 binary later — notably a
// globally installed 9router older than this change, which shares the same
// ~/.9router/runtime — would leave the user waiting out the cooldown.
function clearArm64Attempt() {
  try { fs.rmSync(arm64AttemptMarker(), { force: true }); } catch {}
}

// Throws on any failure so the caller has a single error path.
function downloadFile(url, dest, timeoutSec) {
  // darwin-only path, and curl ships with macOS, so this needs no extra dep and
  // keeps the caller synchronous.
  const res = spawnSync("curl", ["-fsSL", "--max-time", String(timeoutSec), "-o", dest, url], {
    encoding: "utf8",
    timeout: (timeoutSec + 5) * 1000
  });
  if (res.status === 0 && fs.existsSync(dest)) return;
  const detail = (res.stderr || res.error?.message || `curl exit ${res.status}`).trim().split("\n").pop();
  throw new Error(detail || "download failed");
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// Replace systray2's x86_64 macOS binary with a native arm64 build so Apple
// Silicon users get a tray without installing Rosetta 2. Any failure leaves the
// Intel binary untouched, which still works under Rosetta.
//
// Takes no `silent` flag on purpose: cli.js calls ensureTrayRuntime({silent:true})
// synchronously on every start, and a stalled curl would otherwise freeze the
// launch for up to 30s with no output at all. These lines print at most once per
// 24h on failure and once ever on success, so they are worth more than the quiet.
function ensureArm64TrayBin() {
  if (process.platform !== "darwin" || process.arch !== "arm64") return { skipped: true };

  const binPath = path.join(getRuntimeNodeModules(), SYSTRAY_PKG, "traybin", "tray_darwin_release");
  if (!fs.existsSync(binPath)) return { skipped: true };
  if (isArm64MachO(binPath)) {
    // Nothing to download, but the two things an arm64 package binary still
    // needs are cheap to re-assert: the runtime dep declaration that keeps the
    // package across prunes, and the copy cache that systray2 actually executes
    // from (a cleared ~/.cache would otherwise re-copy whatever sits in the
    // package dir — x86_64 after a reinstall).
    declareRuntimeDep(SYSTRAY_PKG, SYSTRAY_VERSION);
    const cachePath = systrayCopyCachePath();
    if (!isArm64MachO(cachePath)) seedSystrayCopyCache(binPath);
    return { native: true };
  }

  // An x86_64 package binary with an arm64 cache copy means a reinstall replaced
  // the overlay but the executed (cached) binary is still native — restore the
  // package binary from the cache so the next cache miss cannot regress it.
  const cachedArm64 = systrayCopyCachePath();
  if (isArm64MachO(cachedArm64)) {
    try {
      fs.copyFileSync(cachedArm64, binPath);
      fs.chmodSync(binPath, 0o755);
      declareRuntimeDep(SYSTRAY_PKG, SYSTRAY_VERSION);
      return { native: true, repaired: true };
    } catch {
      // fall through to the download path
    }
  }
  if (recentlyAttemptedArm64()) return { deferred: true };

  markArm64Attempt();
  console.log("⏳ Downloading native Apple Silicon tray binary...");
  // pid-scoped: two concurrent starts (postinstall racing cli.js, or two
  // terminals) would otherwise interleave writes to one file, fail each other's
  // checksum, and delete each other's in-flight download from the catch below.
  const tmp = `${binPath}.arm64.${process.pid}.tmp`;
  try {
    downloadFile(ARM64_TRAY_URL, tmp, 30);
    const sum = sha256File(tmp);
    // Integrity matters more than usual: this is an executable that runs on
    // every Apple Silicon user's machine.
    if (sum !== ARM64_TRAY_SHA256) throw new Error(`checksum mismatch (got ${sum.slice(0, 12)}…)`);
    if (!isArm64MachO(tmp)) throw new Error("downloaded file is not an arm64 Mach-O");
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, binPath);
    // Keep the package across the next runtime install so the overlay survives:
    // npm prunes packages missing from runtime/package.json and re-extracts them.
    declareRuntimeDep(SYSTRAY_PKG, SYSTRAY_VERSION);
    seedSystrayCopyCache(binPath);
    clearArm64Attempt();
    console.log("✅ Native Apple Silicon tray installed");
    return { native: true, installed: true };
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    console.warn("⚠️  Native Apple Silicon tray binary unavailable — the Intel binary needs Rosetta 2");
    console.warn(`   Reason: ${e.message}`);
    if (isArm64MachO(systrayCopyCachePath())) {
      console.warn("   A previously cached native tray is still in use — no action needed.");
    } else {
      console.warn("   Fix: install Rosetta 2 →  softwareupdate --install-rosetta --agree-to-license");
      console.warn("   (24h retry cooldown after a failure; the tray returns at the next successful run.)");
    }
    return { native: false, error: e.message };
  }
}

function npmInstall(pkgs, { silent = false } = {}) {
  const cwd = ensureRuntimeDir();
  if (!silent) console.log("⏳ Installing system tray (first run)...");
  const res = runNpmInstall({ cwd, pkgs, extraArgs: ["--no-save"], timeout: 120000 });
  if (!res.ok && !silent) {
    const reason = summarizeNpmError(res.stderr);
    console.warn("⚠️  System tray install failed — tray disabled");
    console.warn(`   Reason: ${reason}`);
    console.warn(`   Retry:  cd "${cwd}" && npm install ${pkgs.join(" ")}`);
  }
  return res.ok;
}

// Public: ensure systray2 is installed on macOS/Linux only.
// Windows skips entirely (uses PowerShell tray).
function ensureTrayRuntime({ silent = false } = {}) {
  // Always evict the legacy `systray` package — its binary is broken on
  // modern macOS and an AV false-positive on Windows.
  cleanupLegacySystray({ silent });

  if (process.platform === "win32") {
    return { systray: false, skipped: true };
  }

  let ready = hasSystray();
  if (!ready) {
    ready = npmInstall([`${SYSTRAY_PKG}@${SYSTRAY_VERSION}`], { silent }) && hasSystray();
  }
  if (ready) {
    // Declare it before anything else: the runtime dir is npm-installed into on
    // every sqlite warm-up, and npm prunes packages absent from its manifest —
    // which would delete systray2 (and any arm64 overlay) on the next boot.
    declareRuntimeDep(SYSTRAY_PKG, SYSTRAY_VERSION);
    chmodSystrayBin({ silent });
    if (!silent) console.log("✅ System tray ready");
  }

  // Runs after the ready log so a download failure doesn't read as a broken
  // tray — the Intel binary still works under Rosetta.
  const arm64 = ready ? ensureArm64TrayBin() : { skipped: true };
  return { systray: ready, arm64 };
}

module.exports = { ensureTrayRuntime, ensureArm64TrayBin };
