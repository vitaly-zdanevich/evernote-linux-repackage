#!/usr/bin/env node
"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(ROOT, "dist");
const DEFAULT_APP_DIR = path.join(DIST_DIR, "AppDir");
const TEMPLATE_DIR = path.join(__dirname, "templates");
const APPIMAGE_RUNTIME_LIB_DIR = path.join("usr", "lib", "evernote", "appimage-libs");
const BUNDLED_RUNTIME_LIBRARIES = [
  {
    soname: "libsecret-1.so.0",
    reason: "keytar login secret storage",
  },
];
const DEFAULT_TARGET_ARCH = normalizeTargetArch(
  process.env.EVERNOTE_TARGET_ARCH || process.env.TARGET_ARCH || process.arch,
);

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

function commandPath(command) {
  const result = childProcess.spawnSync("sh", ["-c", 'command -v "$1"', "sh", command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function candidateLibraryDirs() {
  const dirs = new Set();
  for (const entry of String(process.env.LD_LIBRARY_PATH || "").split(":")) {
    if (entry) {
      dirs.add(entry);
    }
  }
  for (const dir of [
    "/lib",
    "/lib64",
    "/usr/lib",
    "/usr/lib64",
    "/lib/x86_64-linux-gnu",
    "/usr/lib/x86_64-linux-gnu",
    "/lib/aarch64-linux-gnu",
    "/usr/lib/aarch64-linux-gnu",
  ]) {
    dirs.add(dir);
  }
  return [...dirs];
}

function ldconfigLibraryPaths(soname) {
  const ldconfig = commandPath("ldconfig");
  if (!ldconfig) {
    return [];
  }

  const result = childProcess.spawnSync(ldconfig, ["-p"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return [];
  }

  const pattern = new RegExp(`^\\s*${escapeRegExp(soname)}\\s+\\([^)]*\\)\\s+=>\\s+(.+)$`);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(pattern);
      return match ? match[1].trim() : "";
    })
    .filter(Boolean);
}

function findSharedLibrary(soname) {
  const candidates = [
    ...ldconfigLibraryPaths(soname),
    ...candidateLibraryDirs().map((dir) => path.join(dir, soname)),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function resetDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
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

function appImageArchForTargetArch(targetArch) {
  if (targetArch === "x64") {
    return "x86_64";
  }
  if (targetArch === "arm64") {
    return "aarch64";
  }
  throw new Error(`Unsupported target architecture: ${targetArch}`);
}

function normalizeAppImageArch(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["x64", "x86_64", "amd64"].includes(normalized)) {
    return "x86_64";
  }
  if (["arm64", "aarch64"].includes(normalized)) {
    return "aarch64";
  }
  throw new Error(`Unsupported AppImage architecture: ${value}`);
}

function readBuildInfo() {
  const buildInfoPath = path.join(DIST_DIR, "build-info.json");
  if (!fs.existsSync(buildInfoPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(buildInfoPath, "utf8"));
}

function readBuildInfoPortDir() {
  const buildInfo = readBuildInfo();
  if (!buildInfo || !buildInfo.portDir) {
    return null;
  }
  return path.isAbsolute(buildInfo.portDir)
    ? buildInfo.portDir
    : path.resolve(ROOT, buildInfo.portDir);
}

function defaultPortDir() {
  const buildInfoPortDir = readBuildInfoPortDir();
  if (buildInfoPortDir && fs.existsSync(buildInfoPortDir)) {
    return buildInfoPortDir;
  }
  return path.join(DIST_DIR, `Evernote-linux-${DEFAULT_TARGET_ARCH}`);
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

function readAsarText(asarPath, filePath) {
  const { buffer, header, baseOffset } = parseAsarHeader(asarPath);
  let entry = header;
  for (const part of filePath.split("/")) {
    entry = entry.files && entry.files[part];
    if (!entry) {
      throw new Error(`ASAR entry not found: ${filePath}`);
    }
  }
  const offset = baseOffset + Number(entry.offset);
  return buffer.subarray(offset, offset + Number(entry.size)).toString();
}

function getEvernoteVersion(portDir) {
  const asarPath = path.join(portDir, "resources", "app.asar");
  const packageJson = JSON.parse(readAsarText(asarPath, "package.json"));
  return packageJson.version || "unknown";
}

function writeFileExecutable(filePath, content) {
  fs.writeFileSync(filePath, content);
  fs.chmodSync(filePath, 0o755);
}

function readTemplate(fileName) {
  return fs.readFileSync(path.join(TEMPLATE_DIR, fileName), "utf8");
}

function convertIcon(portDir, appDir) {
  const sourceIcon = path.join(portDir, "resources", "static", "win", "icons", "icon.ico");
  if (!fs.existsSync(sourceIcon)) {
    throw new Error(`Evernote icon not found: ${sourceIcon}`);
  }

  const magick = commandPath("magick");
  const convert = commandPath("convert");
  const converter = magick || convert;
  if (!converter) {
    throw new Error("ImageMagick is required to convert Evernote's ICO icon to PNG.");
  }

  const rootIcon = path.join(appDir, "evernote.png");
  const hicolorIcon = path.join(
    appDir,
    "usr",
    "share",
    "icons",
    "hicolor",
    "256x256",
    "apps",
    "evernote.png",
  );
  ensureDir(path.dirname(hicolorIcon));

  run(converter, [`${sourceIcon}[0]`, rootIcon]);
  fs.copyFileSync(rootIcon, hicolorIcon);
}

function bundleRuntimeLibraries(appDir) {
  const bundledLibDir = path.join(appDir, APPIMAGE_RUNTIME_LIB_DIR);
  ensureDir(bundledLibDir);

  for (const library of BUNDLED_RUNTIME_LIBRARIES) {
    const source = findSharedLibrary(library.soname);
    if (!source) {
      throw new Error(
        `Required runtime library not found: ${library.soname}. Install libsecret runtime/development packages before packaging.`,
      );
    }

    const destination = path.join(bundledLibDir, library.soname);
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, 0o644);
    log(`Bundled ${library.soname} for ${library.reason}: ${source}`);
  }
}

function appRunScript() {
  return readTemplate("appimage-AppRun.sh");
}

function resolvePortableSourceDir(portDir) {
  return fs.realpathSync(path.resolve(portDir));
}

function prepareAppDir({ portDir, appDir }) {
  const resolvedPortDir = resolvePortableSourceDir(portDir);
  const resolvedAppDir = path.resolve(appDir);

  if (!fs.existsSync(path.join(resolvedPortDir, "evernote"))) {
    throw new Error(`Portable Evernote launcher not found: ${resolvedPortDir}/evernote`);
  }

  resetDir(resolvedAppDir);

  const appLibDir = path.join(resolvedAppDir, "usr", "lib", "evernote");
  const appBinDir = path.join(resolvedAppDir, "usr", "bin");
  const applicationsDir = path.join(resolvedAppDir, "usr", "share", "applications");
  ensureDir(appBinDir);
  ensureDir(applicationsDir);

  fs.cpSync(resolvedPortDir, appLibDir, {
    recursive: true,
    force: true,
    dereference: false,
  });

  fs.symlinkSync("../lib/evernote/evernote", path.join(appBinDir, "evernote"));

  const desktopEntry = [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Evernote",
    "Comment=Evernote desktop client",
    "Exec=evernote %u",
    "Icon=evernote",
    "Terminal=false",
    "Categories=Office;Utility;",
    "MimeType=x-scheme-handler/evernote;",
    "StartupWMClass=Evernote",
    "",
  ].join("\n");

  fs.writeFileSync(path.join(resolvedAppDir, "evernote.desktop"), desktopEntry);
  fs.writeFileSync(path.join(applicationsDir, "evernote.desktop"), desktopEntry);

  bundleRuntimeLibraries(resolvedAppDir);
  writeFileExecutable(path.join(resolvedAppDir, "AppRun"), appRunScript());

  convertIcon(resolvedPortDir, resolvedAppDir);

  return resolvedAppDir;
}

function resolveAppImageTool() {
  if (process.env.APPIMAGETOOL) {
    return path.resolve(process.env.APPIMAGETOOL);
  }
  return commandPath("appimagetool");
}

function packageAppImage({ portDir, appDir, output, appDirOnly }) {
  const resolvedPortDir = path.resolve(portDir);
  const buildInfo = readBuildInfo();
  const targetArch = normalizeTargetArch(
    process.env.EVERNOTE_TARGET_ARCH ||
      process.env.TARGET_ARCH ||
      (buildInfo && buildInfo.targetArch) ||
      process.arch,
  );
  const appImageArch = normalizeAppImageArch(
    process.env.APPIMAGE_ARCH || appImageArchForTargetArch(targetArch),
  );
  const version = getEvernoteVersion(resolvedPortDir);
  const outputPath =
    output || path.join(DIST_DIR, `Evernote-${version}-${appImageArch}.AppImage`);
  const preparedAppDir = prepareAppDir({ portDir: resolvedPortDir, appDir });

  if (appDirOnly) {
    log(`Prepared ${preparedAppDir}`);
    return { appDir: preparedAppDir, outputPath: null };
  }

  const appImageTool = resolveAppImageTool();
  if (!appImageTool) {
    throw new Error(
      "appimagetool not found. Set APPIMAGETOOL=/path/to/AppRun or install appimagetool.",
    );
  }

  const appImageToolArgs = [];
  if (process.env.APPIMAGE_RUNTIME_FILE) {
    const runtimeFile = path.resolve(process.env.APPIMAGE_RUNTIME_FILE);
    if (!fs.existsSync(runtimeFile)) {
      throw new Error(`AppImage runtime file not found: ${runtimeFile}`);
    }
    appImageToolArgs.push("--runtime-file", runtimeFile);
  }
  appImageToolArgs.push(preparedAppDir, outputPath);

  ensureDir(path.dirname(outputPath));
  fs.rmSync(outputPath, { force: true });
  run(appImageTool, appImageToolArgs, {
    env: {
      ARCH: appImageArch,
    },
  });
  fs.chmodSync(outputPath, 0o755);
  log(`Built ${outputPath}`);
  return { appDir: preparedAppDir, outputPath };
}

function parseArgs(argv) {
  const options = {
    portDir: process.env.EVERNOTE_PORT_DIR || defaultPortDir(),
    appDir: process.env.APPDIR || DEFAULT_APP_DIR,
    output: process.env.APPIMAGE_OUTPUT || null,
    appDirOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--appdir-only") {
      options.appDirOnly = true;
    } else if (arg === "--port-dir") {
      options.portDir = argv[++index];
    } else if (arg === "--appdir") {
      options.appDir = argv[++index];
    } else if (arg === "--output") {
      options.output = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

if (require.main === module) {
  try {
    packageAppImage(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

module.exports = {
  APPIMAGE_RUNTIME_LIB_DIR,
  appImageArchForTargetArch,
  appRunScript,
  findSharedLibrary,
  packageAppImage,
  prepareAppDir,
  resolvePortableSourceDir,
};
