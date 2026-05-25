#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(ROOT, "dist");

const REQUIRED_PATCH_MARKERS = [
  {
    name: "warm tab preload disabled",
    value: "preloadWarmTab(){return;",
  },
  {
    name: "auto-updater initialization disabled",
    value: "this._initialized=!0;return;",
  },
  {
    name: "auto-updater checks neutralized",
    value: "Promise.resolve({})",
  },
  {
    name: "missing pending update state tolerated",
    value: "if((0,i.isNullish)(t))return{};",
  },
  {
    name: "in-app force update neutralized",
    value: "return{feedbackLevel:m.InAppForceUpdateFeedbackLevel.none}",
  },
  {
    name: "main window close quits app",
    value: 'h.app.quit(),0}}),this.window.on("show"',
  },
  {
    name: "tab destroy state publish suppressed",
    value:
      "this.tabs.has(t)&&(this.tabs.delete(t),this.activeTabId===t&&(this.onActiveWebContentsChange?.(null,null),this.activeTabId=null))",
  },
];

const REQUIRED_LINUX_NATIVE_MODULES = [
  "node_modules/keytar/build/Release/keytar.node",
  "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  "node_modules/@ronomon/opened/binding.node",
  "node_modules/electron-native-auth/build/Release/electron_native_auth.node",
];

function readBuildInfoPortDir() {
  const buildInfoPath = path.join(DIST_DIR, "build-info.json");
  if (!fs.existsSync(buildInfoPath)) {
    return null;
  }
  const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, "utf8"));
  if (!buildInfo.portDir) {
    return null;
  }
  return path.isAbsolute(buildInfo.portDir)
    ? buildInfo.portDir
    : path.resolve(ROOT, buildInfo.portDir);
}

function parseArgs(argv) {
  const options = {
    portDir: process.env.EVERNOTE_PORT_DIR || readBuildInfoPortDir(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--port-dir") {
      options.portDir = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.portDir) {
    throw new Error("No port directory provided and dist/build-info.json is missing.");
  }

  return options;
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

function listFiles(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...listFiles(filePath));
    } else if (entry.isFile()) {
      result.push(filePath);
    }
  }
  return result;
}

function readMagic(filePath, length = 4) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, 0);
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
}

function isElf(filePath) {
  return readMagic(filePath).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
}

function isWindowsPe(filePath) {
  return readMagic(filePath, 2).equals(Buffer.from("MZ"));
}

function requireFile(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`Required file missing: ${filePath}`);
  }
}

function requireExecutable(filePath) {
  requireFile(filePath);
  fs.accessSync(filePath, fs.constants.X_OK);
}

function verifyElf(filePath) {
  requireFile(filePath);
  if (!isElf(filePath)) {
    const hint = isWindowsPe(filePath) ? "Windows PE file" : "not an ELF file";
    throw new Error(`Expected Linux ELF binary, got ${hint}: ${filePath}`);
  }
}

function verifyNativeModules(portDir) {
  const unpackedDir = path.join(portDir, "resources", "app.asar.unpacked");
  const nodeFiles = listFiles(unpackedDir).filter((filePath) => filePath.endsWith(".node"));
  const requiredNodeFiles = REQUIRED_LINUX_NATIVE_MODULES.map((relativePath) =>
    path.join(unpackedDir, relativePath),
  );

  for (const filePath of requiredNodeFiles) {
    verifyElf(filePath);
  }

  const requiredSet = new Set(requiredNodeFiles.map((filePath) => path.resolve(filePath)));
  const extraNodeFiles = nodeFiles.filter((filePath) => !requiredSet.has(path.resolve(filePath)));
  for (const filePath of extraNodeFiles) {
    if (isElf(filePath)) {
      process.stdout.write(`Found extra Linux native module: ${path.relative(unpackedDir, filePath)}\n`);
    }
  }

  process.stdout.write(
    `Verified ${requiredNodeFiles.length} rebuilt native module(s) are Linux ELF binaries; ignored ${extraNodeFiles.length} packaged platform prebuild(s).\n`,
  );
}

function verifyBundlePatches(asarPath) {
  const mainJs = readAsarText(asarPath, "main.js");
  const missing = REQUIRED_PATCH_MARKERS.filter((marker) => !mainJs.includes(marker.value));
  if (missing.length > 0) {
    throw new Error(`Missing bundle patch marker(s): ${missing.map((marker) => marker.name).join(", ")}`);
  }
  new Function(mainJs);
  process.stdout.write("Verified app.asar patch markers and main.js syntax.\n");
}

function verifyArtifact(options) {
  const portDir = path.resolve(options.portDir);
  const asarPath = path.join(portDir, "resources", "app.asar");

  requireExecutable(path.join(portDir, "evernote"));
  verifyElf(path.join(portDir, "Evernote"));
  verifyElf(path.join(portDir, "chrome-sandbox"));
  requireFile(asarPath);
  requireFile(path.join(portDir, "resources", "app-update.yml"));

  verifyNativeModules(portDir);
  verifyBundlePatches(asarPath);

  process.stdout.write(`Artifact verification passed: ${portDir}\n`);
}

if (require.main === module) {
  try {
    verifyArtifact(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

module.exports = {
  isElf,
  isWindowsPe,
  verifyArtifact,
};
