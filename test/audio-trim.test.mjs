import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/audio-trim.js';
const trim = globalThis.ReplicaTrim;

function buffer(sampleRate = 48000, numberOfChannels = 1) {
  const channels = Array.from({ length: numberOfChannels }, () => new Float32Array(sampleRate));
  return { sampleRate, numberOfChannels, length: sampleRate, duration: 1, getChannelData: i => channels[i] };
}

test('silence detection keeps safety margins, internal pauses and every audio channel', () => {
  for (const sampleRate of [16000, 44100, 48000]) {
    const audio = buffer(sampleRate, 2), samples = audio.getChannelData(1);
    samples.fill(.05, Math.round(.3 * sampleRate), Math.round(.4 * sampleRate));
    samples.fill(.05, Math.round(.5 * sampleRate), Math.round(.7 * sampleRate));
    const result = trim.detect(audio);
    assert.ok(Math.abs(result.voiceTrimStart - .22) < .002);
    assert.ok(Math.abs(result.voiceTrimEnd - .22) < .002);
    const range = trim.range(result, audio.duration);
    assert.ok(range.start < .3 && range.end > .7);
    assert.ok(range.duration > .55); // The internal pause is not removed.
  }
});

test('silent and very quiet recordings are not automatically erased', () => {
  const audio = buffer();
  assert.equal(trim.detect(audio), null);
  audio.getChannelData(0).fill(.0001);
  assert.equal(trim.detect(audio), null);
  audio.getChannelData(0).fill(.05);
  assert.deepEqual(trim.detect(audio), { voiceTrimStart: 0, voiceTrimEnd: 0 });
});

test('trim range supports existing untrimmed takes and rejects an empty result', () => {
  assert.deepEqual(trim.range({}, 1), { start: 0, end: 1, duration: 1 });
  const range = trim.range({ voiceTrimStart: .2, voiceTrimEnd: .3 }, 1);
  assert.equal(range.start, .2); assert.equal(range.end, .7);
  assert.ok(Math.abs(range.duration - .5) < 1e-10);
  assert.throws(() => trim.range({ voiceTrimStart: .5, voiceTrimEnd: .5 }, 1));
  assert.throws(() => trim.range({}, NaN));
});
