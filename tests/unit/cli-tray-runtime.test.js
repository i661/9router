// The arm64 tray overlay in cli/hooks/trayRuntime.js must survive the two things
// that silently destroy it on Apple Silicon:
//   1. npm prunes runtime packages not declared in ~/.9router/runtime/package.json
//      — systray2 is installed --no-save, so without a declaration the next
//      runtime install (sqlite engine warm-up) removes it and re-extracts the
//      x86_64 registry tarball, discarding the overlay.
//   2. systray2 runs the copy of the binary in ~/.cache/node-systray/<version>/,
//      re-copying it from the package dir whenever that cache entry is missing —
//      so an overlay that only replaces the package binary stays invisible.
//
// Exported for cli/scripts/buildTrayArm64.js and hooks/postinstall.js consumers;
// these tests pin the durability behaviour, not the download path.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const hook = require("../../cli/hooks/trayRuntime.js");

const SYSTRAY_VERSION = "2.1.4";
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

// A thin Mach-O header: magic 0xfeedfacf then cputype, both little-endian —
// exactly what isArm64MachO() inspects. Contents are irrelevant to the hook.
function fakeMachO(cputype) {
  const buf = Buffer.alloc(32);
  buf.writeUInt32LE(0xfeedfacf, 0);
  buf.writeUInt32LE(cputype, 4);
  return buf;
}

let dataDir;
let homeDir;
let originalDataDir;
let originalHome;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-tray-data-"));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-tray-home-"));
  originalDataDir = process.env.DATA_DIR;
  originalHome = process.env.HOME;
  process.env.DATA_DIR = dataDir;
  // os.homedir() honours $HOME on POSIX; the hook resolves the copy cache from it.
  process.env.HOME = homeDir;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

const runtimeDir = () => path.join(dataDir, "runtime");
const packageBinPath = () =>
  path.join(runtimeDir(), "node_modules", "systray2", "traybin", "tray_darwin_release");
const copyCachePath = () =>
  path.join(homeDir, ".cache", "node-systray", SYSTRAY_VERSION, "tray_darwin_release");

function seedPackageBinary(contents) {
  const bin = packageBinPath();
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, contents);
}

function writeRuntimeManifest(dependencies) {
  fs.mkdirSync(runtimeDir(), { recursive: true });
  fs.writeFileSync(
    path.join(runtimeDir(), "package.json"),
    JSON.stringify({ name: "9router-runtime", version: "1.0.0", private: true, dependencies }, null, 2),
  );
}

function readRuntimeManifest() {
  return JSON.parse(fs.readFileSync(path.join(runtimeDir(), "package.json"), "utf8"));
}

describe("tray runtime durability (arm64 overlay survival)", () => {
  it("declares systray2 in runtime/package.json so a later npm install cannot prune it", () => {
    seedPackageBinary(fakeMachO(CPU_TYPE_ARM64));
    writeRuntimeManifest({ "sql.js": "^1.14.1" });

    expect(hook.ensureArm64TrayBin().native).toBe(true);

    const manifest = readRuntimeManifest();
    expect(manifest.dependencies.systray2).toBe(SYSTRAY_VERSION);
    // Pre-existing runtime deps must survive the manifest rewrite.
    expect(manifest.dependencies["sql.js"]).toBe("^1.14.1");
  });

  it("seeds the copy cache with the arm64 binary that systray2 actually executes", () => {
    seedPackageBinary(fakeMachO(CPU_TYPE_ARM64));

    expect(hook.ensureArm64TrayBin().native).toBe(true);

    const cached = fs.readFileSync(copyCachePath());
    expect(cached.readUInt32LE(4)).toBe(CPU_TYPE_ARM64);
    expect(fs.statSync(copyCachePath()).mode & 0o111).toBeTruthy(); // executable bit
  });

  it("re-seeds a cleared copy cache on the next run instead of trusting the package binary", () => {
    seedPackageBinary(fakeMachO(CPU_TYPE_ARM64));

    hook.ensureArm64TrayBin();
    expect(fs.existsSync(copyCachePath())).toBe(true);

    // Simulate `rm -rf ~/.cache/node-systray` between boots.
    fs.rmSync(path.join(homeDir, ".cache", "node-systray"), { recursive: true, force: true });
    expect(hook.ensureArm64TrayBin().native).toBe(true);
    expect(fs.readFileSync(copyCachePath()).readUInt32LE(4)).toBe(CPU_TYPE_ARM64);
  });

  it("does not rewrite an already-arm64 copy cache", () => {
    seedPackageBinary(fakeMachO(CPU_TYPE_ARM64));
    hook.ensureArm64TrayBin();
    const before = fs.statSync(copyCachePath()).mtimeMs;

    hook.ensureArm64TrayBin();
    expect(fs.statSync(copyCachePath()).mtimeMs).toBe(before);
  });

  it("leaves an x86_64 package binary alone on a non-arm64 host", () => {
    const originalArch = Object.getOwnPropertyDescriptor(process, "arch");
    Object.defineProperty(process, "arch", { value: "x64", configurable: true });
    try {
      seedPackageBinary(fakeMachO(CPU_TYPE_X86_64));
      expect(hook.ensureArm64TrayBin().skipped).toBe(true);
      expect(fs.readFileSync(packageBinPath()).readUInt32LE(4)).toBe(CPU_TYPE_X86_64);
      expect(fs.existsSync(copyCachePath())).toBe(false);
    } finally {
      Object.defineProperty(process, "arch", originalArch);
    }
  });

  it("repairs an x86_64 package binary from the arm64 cache without downloading", () => {
    // Exactly the state a runtime reinstall leaves behind: the registry's x86_64
    // tarball replaced the package binary, while the executed cache copy is arm64.
    seedPackageBinary(fakeMachO(CPU_TYPE_X86_64));
    fs.mkdirSync(path.dirname(copyCachePath()), { recursive: true });
    fs.writeFileSync(copyCachePath(), fakeMachO(CPU_TYPE_ARM64));

    const result = hook.ensureArm64TrayBin();

    expect(result.native).toBe(true);
    expect(result.repaired).toBe(true);
    expect(fs.readFileSync(packageBinPath()).readUInt32LE(4)).toBe(CPU_TYPE_ARM64);
    // The repair must also keep the package across the next prune.
    expect(readRuntimeManifest().dependencies.systray2).toBe(SYSTRAY_VERSION);
  });

  it("repairs even while inside the failed-download cooldown window", () => {
    seedPackageBinary(fakeMachO(CPU_TYPE_X86_64));
    fs.mkdirSync(path.dirname(copyCachePath()), { recursive: true });
    fs.writeFileSync(copyCachePath(), fakeMachO(CPU_TYPE_ARM64));
    // Simulate a download that failed earlier today.
    fs.writeFileSync(path.join(runtimeDir(), ".tray-arm64-attempt"), String(Date.now()));

    const result = hook.ensureArm64TrayBin();

    expect(result.repaired).toBe(true);
    expect(fs.readFileSync(packageBinPath()).readUInt32LE(4)).toBe(CPU_TYPE_ARM64);
  });
});
