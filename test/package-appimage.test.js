const assert = require("assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  APPIMAGE_RUNTIME_LIB_DIR,
  appImageArchForTargetArch,
  appRunScript,
  findSharedLibrary,
  resolvePortableSourceDir,
} = require("../scripts/package-appimage");

test("maps supported Node architectures to AppImage architectures", () => {
  assert.equal(appImageArchForTargetArch("x64"), "x86_64");
  assert.equal(appImageArchForTargetArch("arm64"), "aarch64");
});

test("rejects unsupported AppImage target architectures", () => {
  assert.throws(() => appImageArchForTargetArch("ia32"), /Unsupported target architecture/);
});

test("AppRun points Electron at bundled AppImage runtime libraries", () => {
  const script = appRunScript();

  assert.match(script, new RegExp(`BUNDLED_LIB_DIR="\\$APPDIR/${APPIMAGE_RUNTIME_LIB_DIR}"`));
  assert.match(script, /LD_LIBRARY_PATH="\$BUNDLED_LIB_DIR:\$LD_LIBRARY_PATH"/);
  assert.match(script, /LD_LIBRARY_PATH="\$BUNDLED_LIB_DIR"/);
  assert.match(script, /exec "\$APPDIR\/usr\/lib\/evernote\/evernote" "\$@"/);
});

test("packager returns null for missing shared libraries", () => {
  assert.equal(findSharedLibrary("libnot-a-real-evernote-test-library.so"), null);
});

test("packager resolves portable directory symlinks before copying", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "evernote-appimage-test-"));
  try {
    const targetDir = path.join(tempDir, "Evernote-11.17.3-linux-x64");
    const symlinkDir = path.join(tempDir, "Evernote-linux-x64");
    fs.mkdirSync(targetDir);
    fs.symlinkSync(targetDir, symlinkDir);

    assert.equal(resolvePortableSourceDir(symlinkDir), targetDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
