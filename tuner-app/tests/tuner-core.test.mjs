import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILT_IN_TUNINGS,
  QUALITY_CLARITY_THRESHOLD,
  adaptiveSilenceThreshold,
  centsBetween,
  detectPitchAutoCorrelation,
  frequencyForMidi,
  hasStablePitchFrequencies,
  isTrustedReadingExpired,
  learnNoiseFloorFromFrame,
  midiForFrequency,
  nearestStringTarget,
  normalizeImportedTunings,
  portableTuning,
  resolveOctaveFundamental,
  rmsForBuffer,
  selectAutomaticTarget,
  updateAdaptiveNoiseFloor,
} from "../src/tuner-core.mjs";

function sineWave(frequency, sampleRate = 44100, length = 8192) {
  return Float32Array.from({ length }, (_, index) => Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0.7);
}

function weakHarmonicWave(frequency, sampleRate = 44100, length = 8192) {
  return Float32Array.from({ length }, (_, index) => {
    const time = index / sampleRate;
    return 0.006 * (
      Math.sin(2 * Math.PI * frequency * time)
      + 0.45 * Math.sin(2 * Math.PI * frequency * 2 * time)
      + 0.2 * Math.sin(2 * Math.PI * frequency * 3 * time)
    );
  });
}

function octaveTrapWave(frequency, sampleRate = 44100, length = 8192) {
  return Float32Array.from({ length }, (_, index) => {
    const time = index / sampleRate;
    return 0.018 * (
      0.1 * Math.sin(2 * Math.PI * frequency * time)
      + 1.7 * Math.sin(2 * Math.PI * frequency * 2 * time)
      + 0.5 * Math.sin(2 * Math.PI * frequency * 3 * time)
    );
  });
}

function noisySineWave(frequency, sampleRate = 44100, length = 8192) {
  let seed = 42;
  return Float32Array.from({ length }, (_, index) => {
    seed = (seed * 16807) % 2147483647;
    const whiteNoise = ((seed / 2147483647) * 2 - 1) * 0.1;
    const lowHum = Math.sin((2 * Math.PI * 60 * index) / sampleRate) * 0.08;
    const highNoise = Math.sin((2 * Math.PI * 720 * index) / sampleRate) * 0.06;
    return Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0.62 + whiteNoise + lowHum + highNoise;
  });
}

function whiteNoise(length = 8192) {
  let seed = 73;
  return Float32Array.from({ length }, () => {
    seed = (seed * 48271) % 2147483647;
    return ((seed / 2147483647) * 2 - 1) * 0.12;
  });
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

test("detection window covers low custom tunings and high custom strings", () => {
  // B1 (baritone), C2 (Drop C) and A4 sit outside the old 70–420 Hz window.
  for (const frequency of [61.7354, 65.4064, 440]) {
    const pitch = detectPitchAutoCorrelation(sineWave(frequency), 44100);
    assert.ok(pitch, `expected ${frequency} Hz to be detected`);
    assert.ok(Math.abs(pitch.frequency - frequency) / frequency < 0.012, `${frequency} Hz should stay accurate`);
  }
});

test("weak but periodic guitar signals pass the initial silence gate", () => {
  const weakLowE = weakHarmonicWave(82.4069);
  const pitch = detectPitchAutoCorrelation(weakLowE, 44100, {
    clarityThreshold: QUALITY_CLARITY_THRESHOLD,
    silenceThreshold: adaptiveSilenceThreshold(0.00075),
    rms: rmsForBuffer(weakLowE),
  });
  assert.ok(pitch);
  assert.ok(Math.abs(pitch.frequency - 82.4069) / 82.4069 < 0.012);
});

test("harmonic evidence corrects an octave-up C3 candidate without lowering true C4", () => {
  const c3 = 130.8128;
  const harmonicHeavyC3 = octaveTrapWave(c3);
  const detected = detectPitchAutoCorrelation(harmonicHeavyC3, 44100, {
    silenceThreshold: adaptiveSilenceThreshold(0.00075),
    rms: rmsForBuffer(harmonicHeavyC3),
  });
  assert.ok(detected);
  assert.ok(Math.abs(detected.frequency - c3) / c3 < 0.012);

  const c4 = sineWave(c3 * 2);
  assert.ok(Math.abs(resolveOctaveFundamental(c4, 44100, c3 * 2) - c3 * 2) / (c3 * 2) < 0.001);
});

test("noise floor learns sustained moderate noise but ignores loud plucks", () => {
  let floor = 0.00075;
  for (let index = 0; index < 20; index += 1) floor = learnNoiseFloorFromFrame(floor, 0.008);
  assert.ok(floor > 0.00075);
  const learnedFloor = floor;
  // A loud pluck that failed the clarity gate must not raise the floor.
  for (let index = 0; index < 20; index += 1) floor = learnNoiseFloorFromFrame(floor, 0.05);
  assert.equal(floor, learnedFloor);
  assert.ok(adaptiveSilenceThreshold(floor) < 0.05);
});

test("quality gate keeps guitar tones with mixed noise and rejects unpitched noise", () => {
  const noisyTarget = noisySineWave(110);
  const pitch = detectPitchAutoCorrelation(noisyTarget, 44100, {
    clarityThreshold: QUALITY_CLARITY_THRESHOLD,
    rms: rmsForBuffer(noisyTarget),
  });
  assert.ok(pitch);
  assert.ok(Math.abs(pitch.frequency - 110) / 110 < 0.012);

  const noise = whiteNoise();
  assert.equal(detectPitchAutoCorrelation(noise, 44100, {
    clarityThreshold: QUALITY_CLARITY_THRESHOLD,
    rms: rmsForBuffer(noise),
  }), null);
});

test("adaptive gate learns rejected background noise without muting quiet rooms", () => {
  let floor = 0.00075;
  for (let index = 0; index < 8; index += 1) floor = updateAdaptiveNoiseFloor(floor, 0.02);
  assert.ok(adaptiveSilenceThreshold(floor) > 0.02);
  const quieterFloor = updateAdaptiveNoiseFloor(floor, 0.003);
  assert.ok(quieterFloor < floor);
  assert.equal(adaptiveSilenceThreshold(0.001), 0.0015);
});

test("nearest target and hysteresis avoid unnecessary string hopping", () => {
  const standard = BUILT_IN_TUNINGS[0];
  const closest = nearestStringTarget(standard, 111);
  assert.equal(closest.target.note, "A");
  const retained = selectAutomaticTarget(standard, 123, standard.strings[1].id);
  assert.equal(retained.id, standard.strings[1].id);
});

test("stable pitch confirmation rejects alternating signals and expires stale readings", () => {
  assert.equal(hasStablePitchFrequencies([110, 110.5, 109.7]), true);
  assert.equal(hasStablePitchFrequencies([110, 196, 110]), false);
  assert.equal(hasStablePitchFrequencies([110, 110.5], 2), true);
  assert.equal(isTrustedReadingExpired(1000, 1519), false);
  assert.equal(isTrustedReadingExpired(1000, 1521), true);
});

test("portable tuning payloads can be imported while malformed data is ignored", () => {
  const portable = portableTuning(BUILT_IN_TUNINGS[0]);
  const imported = normalizeImportedTunings(portable);
  assert.equal(imported.length, 1);
  assert.equal(imported[0].name, "标准");
  assert.deepEqual(imported[0].strings.map((item) => `${item.note}${item.octave}`), ["E2", "A2", "D3", "G3", "B3", "E4"]);
  assert.deepEqual(normalizeImportedTunings({ name: "坏配置", strings: [] }), []);
});
