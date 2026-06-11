const assert = require('assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  APPIMAGE_RUNTIME_LIB_DIR,
  appImageArchForTargetArch,
  appRunScript,
  findSharedLibrary,
  resolvePortableSourceDir,
  splashScript,
} = require('../scripts/package-appimage');

test('maps supported Node architectures to AppImage architectures', () => {
  assert.equal(appImageArchForTargetArch('x64'), 'x86_64');
  assert.equal(appImageArchForTargetArch('arm64'), 'aarch64');
});

test('rejects unsupported AppImage target architectures', () => {
  assert.throws(() => appImageArchForTargetArch('ia32'), /Unsupported target architecture/);
});

test('AppRun points Electron at bundled AppImage runtime libraries', () => {
  const script = appRunScript();

  assert.match(script, new RegExp(`BUNDLED_LIB_DIR="\\$APPDIR/${APPIMAGE_RUNTIME_LIB_DIR}"`));
  assert.match(script, /LD_LIBRARY_PATH="\$BUNDLED_LIB_DIR:\$LD_LIBRARY_PATH"/);
  assert.match(script, /LD_LIBRARY_PATH="\$BUNDLED_LIB_DIR"/);
  assert.match(script, /start_splash/);
  assert.match(script, /command -v wish/);
  assert.match(script, /appimage-splash\.tcl/);
  assert.match(script, /appimage-splash-logo\.png/);
  assert.match(script, /awk '\{print tolower\(\$3\)\}'/);
  assert.match(script, /grep -E '\(\^\|\\\.\)evernote\(\\\.\|\$\)'/);
  assert.doesNotMatch(script, /grep -i 'Evernote'/);
  assert.match(script, /"\$APPDIR\/usr\/lib\/evernote\/evernote" "\$@" &/);
  assert.match(script, /wait "\$EVERNOTE_PID"/);
});

test('AppImage pre-splash renders a black Evernote loading window', () => {
  const script = splashScript();

  assert.match(script, /wm overrideredirect \.splash 1/);
  assert.match(script, /\.splash configure -background "#000000"/);
  assert.match(script, /image create photo evernote_logo -file \$logo_path/);
  assert.match(script, /-fill "#00A82D"/);
  assert.match(script, /proc animate_splash/);
  assert.match(script, /after 15000 exit/);
});

test('packager returns null for missing shared libraries', () => {
  assert.equal(findSharedLibrary('libnot-a-real-evernote-test-library.so'), null);
});

test('packager resolves portable directory symlinks before copying', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evernote-appimage-test-'));
  try {
    const targetDir = path.join(tempDir, 'Evernote-11.17.3-linux-x64');
    const symlinkDir = path.join(tempDir, 'Evernote-linux-x64');
    fs.mkdirSync(targetDir);
    fs.symlinkSync(targetDir, symlinkDir);

    assert.equal(resolvePortableSourceDir(symlinkDir), targetDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
