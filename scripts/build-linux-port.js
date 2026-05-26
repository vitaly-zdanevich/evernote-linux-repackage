#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const childProcess = require("child_process");
const { patchEvernoteBundle } = require("./patch-evernote-bundle");

const ROOT = path.resolve(__dirname, "..");
const CACHE_DIR = path.join(ROOT, ".cache");
const DIST_DIR = path.join(ROOT, "dist");
const WORK_DIR = path.join(CACHE_DIR, "work");
const TEMPLATE_DIR = path.join(__dirname, "templates");

const EVERNOTE_URL =
  process.env.EVERNOTE_URL ||
  "https://win.desktop.evernote.com/builds/Evernote-latest.exe";
const EVERNOTE_SHA256 = normalizeSha256(process.env.EVERNOTE_SHA256, "EVERNOTE_SHA256");
const EVERNOTE_EXPECTED_VERSION = process.env.EVERNOTE_EXPECTED_VERSION || "";
const EVERNOTE_CACHE_NAME = cacheFileName(
  process.env.EVERNOTE_CACHE_NAME ||
    (EVERNOTE_SHA256 ? `Evernote-${EVERNOTE_SHA256.slice(0, 12)}.exe` : "Evernote-latest.exe"),
  "Evernote-latest.exe",
);
const FALLBACK_ELECTRON_VERSION = process.env.ELECTRON_VERSION || "37.6.0";
const ELECTRON_SHA256 = normalizeSha256(process.env.ELECTRON_SHA256, "ELECTRON_SHA256");
const ELECTRON_EXPECTED_VERSION = process.env.ELECTRON_EXPECTED_VERSION || "";
const BUILD_FLAVOR = process.env.BUILD_FLAVOR || (EVERNOTE_SHA256 ? "pinned" : "latest");
const TARGET_ARCH = normalizeTargetArch(
  process.env.EVERNOTE_TARGET_ARCH || process.env.TARGET_ARCH || process.arch,
);
const SUPPORTED_TARGET_ARCHES = new Set(["x64", "arm64"]);

const nativeModules = [
  {
    name: "keytar",
    packagePath: "node_modules/keytar/package.json",
    source: "node_modules/keytar/build/Release/keytar.node",
    target: "resources/app.asar.unpacked/node_modules/keytar/build/Release/keytar.node",
  },
  {
    name: "better-sqlite3",
    packagePath: "node_modules/better-sqlite3/package.json",
    source: "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
    target:
      "resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  },
  {
    name: "@ronomon/opened",
    packagePath: "node_modules/@ronomon/opened/package.json",
    source: "node_modules/@ronomon/opened/binding.node",
    target:
      "resources/app.asar.unpacked/node_modules/@ronomon/opened/binding.node",
  },
  {
    name: "electron-native-auth",
    packagePath: "node_modules/electron-native-auth/package.json",
    source:
      "node_modules/electron-native-auth/build/Release/electron_native_auth.node",
    target:
      "resources/app.asar.unpacked/node_modules/electron-native-auth/build/Release/electron_native_auth.node",
  },
];

function log(message) {
  process.stdout.write(`${message}\n`);
}

function run(command, args, options = {}) {
  log(`$ ${[command, ...args].join(" ")}`);
  const result = childProcess.spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: { ...process.env, ...(options.env || {}) },
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function requireCommand(command) {
  const result = childProcess.spawnSync("sh", ["-c", 'command -v "$1"', "sh", command], {
    stdio: "ignore",
  });
  if (result.status !== 0) {
    throw new Error(`Required command not found: ${command}`);
  }
}

function resetDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function normalizeSha256(value, name) {
  if (!value) {
    return "";
  }
  const normalized = String(value).trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${name} must be a 64-character hex SHA-256 digest.`);
  }
  return normalized;
}

function normalizeTargetArch(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["x64", "x86_64", "amd64"].includes(normalized)) {
    return "x64";
  }
  if (["arm64", "aarch64"].includes(normalized)) {
    return "arm64";
  }
  return normalized;
}

function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function cacheFileName(value, fallback) {
  const fileName = safeFileNamePart(path.basename(value || fallback));
  return fileName && fileName !== "." ? fileName : fallback;
}

function download(url, destination, expectedSha256 = "") {
  if (fs.existsSync(destination) && fs.statSync(destination).size > 0) {
    if (!expectedSha256) {
      log(`Using cached ${destination}`);
      return hashFile(destination);
    }

    const cachedSha256 = hashFile(destination);
    if (cachedSha256 === expectedSha256) {
      log(`Using cached ${destination}`);
      return cachedSha256;
    }

    log(`Cached ${destination} checksum mismatch; downloading a fresh copy`);
    fs.rmSync(destination, { force: true });
  }
  ensureDir(path.dirname(destination));
  run("curl", ["-L", "--retry", "3", "-o", destination, url]);
  const actualSha256 = hashFile(destination);
  if (expectedSha256 && actualSha256 !== expectedSha256) {
    throw new Error(
      `Checksum mismatch for ${url}: expected ${expectedSha256}, got ${actualSha256}`,
    );
  }
  return actualSha256;
}

function copyInto(src, dest) {
  ensureDir(path.dirname(dest));
  fs.cpSync(src, dest, { recursive: true, force: true, dereference: false });
}

function safeFileNamePart(value) {
  return String(value).replace(/[^A-Za-z0-9._+-]/g, "_");
}

function parseAsarHeader(asarPath) {
  const buffer = fs.readFileSync(asarPath);
  const headerSize = buffer.readUInt32LE(4);
  const jsonSize = buffer.readUInt32LE(12);
  const header = JSON.parse(buffer.subarray(16, 16 + jsonSize).toString());
  return {
    buffer,
    header,
    baseOffset: 8 + headerSize,
  };
}

function asarEntry(header, filePath) {
  let entry = header;
  for (const part of filePath.split("/")) {
    entry = entry.files && entry.files[part];
    if (!entry) {
      throw new Error(`ASAR entry not found: ${filePath}`);
    }
  }
  return entry;
}

function readAsarText(asarPath, filePath) {
  const { buffer, header, baseOffset } = parseAsarHeader(asarPath);
  const entry = asarEntry(header, filePath);
  if (entry.unpacked) {
    return fs.readFileSync(`${asarPath}.unpacked/${filePath}`, "utf8");
  }
  const offset = baseOffset + Number(entry.offset);
  return buffer.subarray(offset, offset + Number(entry.size)).toString();
}

function detectElectronVersion(payloadDir) {
  const exePath = path.join(payloadDir, "Evernote.exe");
  const text = fs.readFileSync(exePath).toString("latin1");
  const match = text.match(/Electron\/(\d+\.\d+\.\d+)/);
  return match ? match[1] : FALLBACK_ELECTRON_VERSION;
}

function getNativeModuleSpecs(asarPath) {
  return nativeModules.map((mod) => {
    const pkg = JSON.parse(readAsarText(asarPath, mod.packagePath));
    return {
      ...mod,
      version: pkg.version,
    };
  });
}

function buildNativeModules(asarPath, electronVersion) {
  const modules = getNativeModuleSpecs(asarPath);
  const nativeBuildDir = path.join(WORK_DIR, "native");
  resetDir(nativeBuildDir);
  fs.writeFileSync(
    path.join(nativeBuildDir, "package.json"),
    JSON.stringify(
      {
        private: true,
        name: "evernote-linux-repackage-native-build",
        version: "0.0.0",
      },
      null,
      2,
    ),
  );

  const packages = modules.map((mod) => `${mod.name}@${mod.version}`);
  run("npm", ["install", ...packages], {
    cwd: nativeBuildDir,
    env: {
      npm_config_build_from_source: "true",
      npm_config_runtime: "electron",
      npm_config_target: electronVersion,
      npm_config_disturl: "https://electronjs.org/headers",
    },
  });

  return modules.map((mod) => ({
    ...mod,
    builtPath: path.join(nativeBuildDir, mod.source),
  }));
}

function readTemplate(fileName) {
  return fs.readFileSync(path.join(TEMPLATE_DIR, fileName), "utf8");
}

function launcherScript() {
  return readTemplate("evernote-launcher.sh");
}

function makeLauncher(outDir) {
  const launcherPath = path.join(outDir, "evernote");
  fs.writeFileSync(launcherPath, launcherScript());
  fs.chmodSync(launcherPath, 0o755);
}

function patchStaticResources(resourcesDir) {
  const splashScreenPath = path.join(resourcesDir, "static", "splashscreen", "splashscreen.html");
  if (!fs.existsSync(splashScreenPath)) {
    throw new Error(`Splash screen not found: ${splashScreenPath}`);
  }

  const source = fs.readFileSync(splashScreenPath, "utf8");
  const patched = source
    .replace(
      '<html style="height: 100%; width: 100%; overflow: hidden">',
      '<html style="height: 100%; width: 100%; overflow: hidden; background: #000">',
    )
    .replace(/background: rgb\((?:26 26 26|255 255 255)\);/g, "background: rgb(0 0 0);")
    .replace("color: rgb(26 26 26);", "color: rgb(255 255 255);")
    .replace(
      '<body style="height: 100%; width: 100%">',
      '<body style="height: 100%; width: 100%; background: #000; color: #fff">',
    );

  if (patched === source) {
    throw new Error(`Splash screen patch target not found: ${splashScreenPath}`);
  }
  fs.writeFileSync(splashScreenPath, patched);
}

function build() {
  if (process.platform !== "linux") {
    throw new Error("This build script must run on Linux.");
  }
  if (!SUPPORTED_TARGET_ARCHES.has(TARGET_ARCH)) {
    throw new Error(`Unsupported target architecture: ${TARGET_ARCH}`);
  }
  if (process.arch !== TARGET_ARCH) {
    throw new Error(
      `Target architecture ${TARGET_ARCH} must be built on a ${TARGET_ARCH} Linux host; native module cross-compilation is not supported.`,
    );
  }

  for (const command of ["curl", "7z", "unzip", "npm", "node"]) {
    requireCommand(command);
  }

  ensureDir(CACHE_DIR);
  resetDir(WORK_DIR);
  ensureDir(DIST_DIR);

  const installerPath = path.join(CACHE_DIR, EVERNOTE_CACHE_NAME);
  const nsisDir = path.join(WORK_DIR, "nsis");
  const payloadDir = path.join(WORK_DIR, "payload");

  const evernoteSha256 = download(EVERNOTE_URL, installerPath, EVERNOTE_SHA256);
  resetDir(nsisDir);
  resetDir(payloadDir);
  run("7z", [
    "x",
    "-y",
    installerPath,
    `-o${nsisDir}`,
    "$PLUGINSDIR/app-64.7z",
    "resources/icon.ico",
  ]);
  run("7z", [
    "x",
    "-y",
    path.join(nsisDir, "$PLUGINSDIR", "app-64.7z"),
    `-o${payloadDir}`,
  ]);

  const asarPath = path.join(payloadDir, "resources", "app.asar");
  const packageJson = JSON.parse(readAsarText(asarPath, "package.json"));
  const electronVersion = detectElectronVersion(payloadDir);
  if (EVERNOTE_EXPECTED_VERSION && packageJson.version !== EVERNOTE_EXPECTED_VERSION) {
    throw new Error(
      `Evernote version mismatch: expected ${EVERNOTE_EXPECTED_VERSION}, got ${packageJson.version}`,
    );
  }
  if (ELECTRON_EXPECTED_VERSION && electronVersion !== ELECTRON_EXPECTED_VERSION) {
    throw new Error(
      `Electron version mismatch: expected ${ELECTRON_EXPECTED_VERSION}, got ${electronVersion}`,
    );
  }
  log(`Evernote version: ${packageJson.version}`);
  log(`Electron version: ${electronVersion}`);

  const electronZip = path.join(
    CACHE_DIR,
    `electron-v${electronVersion}-linux-${TARGET_ARCH}.zip`,
  );
  const electronDir = path.join(WORK_DIR, "electron");
  const electronSha256 = download(
    `https://github.com/electron/electron/releases/download/v${electronVersion}/electron-v${electronVersion}-linux-${TARGET_ARCH}.zip`,
    electronZip,
    ELECTRON_SHA256,
  );
  resetDir(electronDir);
  run("unzip", ["-q", "-o", electronZip, "-d", electronDir]);

  const builtNativeModules = buildNativeModules(asarPath, electronVersion);

  const evernoteVersion = safeFileNamePart(packageJson.version);
  const outDirName = `Evernote-${evernoteVersion}-linux-${TARGET_ARCH}`;
  const outDir = path.join(DIST_DIR, outDirName);
  const compatibilityDir = path.join(DIST_DIR, `Evernote-linux-${TARGET_ARCH}`);
  resetDir(outDir);
  copyInto(electronDir, outDir);

  const outResources = path.join(outDir, "resources");
  copyInto(path.join(payloadDir, "resources", "app.asar"), path.join(outResources, "app.asar"));
  const bundlePatchResult = patchEvernoteBundle(path.join(outResources, "app.asar"));
  const patchCount = Object.entries(bundlePatchResult).filter(
    ([key, value]) => key !== "asarPath" && value,
  ).length;
  log(`Patched app.asar: ${patchCount} bundle patch(es) applied`);
  copyInto(
    path.join(payloadDir, "resources", "app.asar.unpacked"),
    path.join(outResources, "app.asar.unpacked"),
  );
  copyInto(path.join(payloadDir, "resources", "static"), path.join(outResources, "static"));
  patchStaticResources(outResources);
  copyInto(
    path.join(payloadDir, "resources", "app-update.yml"),
    path.join(outResources, "app-update.yml"),
  );

  for (const mod of builtNativeModules) {
    if (!fs.existsSync(mod.builtPath)) {
      throw new Error(`Built native module not found: ${mod.builtPath}`);
    }
    copyInto(mod.builtPath, path.join(outDir, mod.target));
  }

  fs.renameSync(path.join(outDir, "electron"), path.join(outDir, "Evernote"));
  makeLauncher(outDir);

  fs.rmSync(compatibilityDir, { recursive: true, force: true });
  fs.symlinkSync(outDirName, compatibilityDir, "dir");

  const buildInfo = {
    buildFlavor: BUILD_FLAVOR,
    evernoteUrl: EVERNOTE_URL,
    evernoteSha256,
    evernoteVersion: packageJson.version,
    electronVersion,
    electronSha256,
    targetArch: TARGET_ARCH,
    portDir: path.relative(ROOT, outDir),
    compatibilityDir: path.relative(ROOT, compatibilityDir),
  };
  fs.writeFileSync(
    path.join(DIST_DIR, "build-info.json"),
    `${JSON.stringify(buildInfo, null, 2)}\n`,
  );

  log("");
  log(`Built ${outDir}`);
  log(`Compatibility link: ${compatibilityDir}`);
  log(`Run with: ${path.join(outDir, "evernote")}`);
}

if (require.main === module) {
  try {
    build();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

module.exports = { launcherScript, patchStaticResources };
