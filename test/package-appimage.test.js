const assert = require("assert/strict");
const test = require("node:test");

const { appImageArchForTargetArch } = require("../scripts/package-appimage");

test("maps supported Node architectures to AppImage architectures", () => {
  assert.equal(appImageArchForTargetArch("x64"), "x86_64");
  assert.equal(appImageArchForTargetArch("arm64"), "aarch64");
});

test("rejects unsupported AppImage target architectures", () => {
  assert.throws(() => appImageArchForTargetArch("ia32"), /Unsupported target architecture/);
});
