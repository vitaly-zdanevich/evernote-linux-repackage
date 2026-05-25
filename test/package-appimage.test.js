const assert = require("assert/strict");
const test = require("node:test");

const {
  APPIMAGE_RUNTIME_LIB_DIR,
  appImageArchForTargetArch,
  appRunScript,
  findSharedLibrary,
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

  assert.match(script, new RegExp(`LD_LIBRARY_PATH="\\$APPDIR/${APPIMAGE_RUNTIME_LIB_DIR}`));
  assert.match(script, /exec "\$APPDIR\/usr\/lib\/evernote\/evernote" "\$@"/);
});

test("packager returns null for missing shared libraries", () => {
  assert.equal(findSharedLibrary("libnot-a-real-evernote-test-library.so"), null);
});
