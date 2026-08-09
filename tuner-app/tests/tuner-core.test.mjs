import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILT_IN_TUNINGS,
  centsBetween,
  detectPitchAutoCorrelation,
  frequencyForMidi,
  midiForFrequency,
  nearestStringTarget,
  selectAutomaticTarget,
} from "../src/tuner-core.mjs";

function sineWave(frequency, sampleRate = 44100, length = 8192) {
  return Float32Array.from({ length }, (_, index) => Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0.7);
}

test("A4 frequency, MIDI and cents conversions are consistent", () => {
  assert.equal(frequencyForMidi(69), 440);
  assert.equal(midiForFrequency(440), 69);
  assert.ok(Math.abs(centsBetween(445, 440) - 19.56) < 0.1);
});

test("standard tuning contains the six canonical guitar string targets", () => {
  const standard = BUILT_IN_TUNINGS[0];
  assert.deepEqual(standard.strings.map((item) => `${item.note}${item.octave}`), ["E2", "A2", "D3", "G3", "B3", "E4"]);
  assert.ok(Math.abs(standard.strings[0].frequency - 82.4069) < 0.01);
});

test("autocorrelation detects low and high standard guitar strings from synthetic waves", () => {
  for (const frequency of [82.4069, 110, 146.832, 196, 246.942, 329.628]) {
    const pitch = detectPitchAutoCorrelation(sineWave(frequency), 44100);
    assert.ok(pitch, `expected ${frequency} Hz to be detected`);
    assert.ok(Math.abs(pitch.frequency - frequency) / frequency < 0.008, `${frequency} Hz should stay accurate`);
  }
});

test("nearest target and hysteresis avoid unnecessary string hopping", () => {
  const standard = BUILT_IN_TUNINGS[0];
  const closest = nearestStringTarget(standard, 111);
  assert.equal(closest.target.note, "A");
  const retained = selectAutomaticTarget(standard, 123, standard.strings[1].id);
  assert.equal(retained.id, standard.strings[1].id);
});
