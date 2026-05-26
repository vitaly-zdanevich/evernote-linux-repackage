const assert = require('node:assert/strict');
const test = require('node:test');

const { MIME_TYPES, parseArgs } = require('../scripts/check-media-support');

test('media support probe checks FLAC MIME aliases', () => {
  assert.ok(MIME_TYPES.includes('audio/flac'));
  assert.ok(MIME_TYPES.includes('audio/flac  '));
  assert.ok(MIME_TYPES.includes('audio/x-flac'));
});

test('media support probe parses Electron path', () => {
  assert.deepEqual(parseArgs(['--electron', '/tmp/electron', '--no-xvfb']), {
    electron: '/tmp/electron',
    useXvfb: false,
  });
});
