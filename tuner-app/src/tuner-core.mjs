export const A4_FREQUENCY = 440;
export const IN_TUNE_CENTS = 5;
// Detection window must cover custom tunings: low strings such as Drop C
// (C2 ≈ 65.4 Hz) or baritone B1 ≈ 61.7 Hz down to A1 = 55 Hz, and high
// strings up to A4 = 440 Hz.
export const GUITAR_MIN_FREQUENCY = 55;
export const GUITAR_MAX_FREQUENCY = 450;
// Keep the clarity gate at the historical 0.72: low strings are
// harmonic-rich and their autocorrelation peak is naturally weaker, so a
// stricter gate rejects real playing. Steadiness is enforced separately by
// the multi-frame stability check.
export const QUALITY_CLARITY_THRESHOLD = 0.72;
export const TRUSTED_READING_HOLD_MS = 520;

const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

export function frequencyForMidi(midi, reference = A4_FREQUENCY) {
  return reference * 2 ** ((midi - 69) / 12);
}

export function midiForFrequency(frequency, reference = A4_FREQUENCY) {
  return 69 + 12 * Math.log2(frequency / reference);
}

export function centsBetween(frequency, targetFrequency) {
  return 1200 * Math.log2(frequency / targetFrequency);
}

export function formatNote(midi) {
  const rounded = Math.round(midi);
  return {
    note: NOTE_NAMES[((rounded % 12) + 12) % 12],
    octave: Math.floor(rounded / 12) - 1,
    midi: rounded,
  };
}

export function createStringTarget(id, note, octave, stringNumber) {
  const noteIndex = NOTE_NAMES.indexOf(note);
  if (noteIndex < 0 || !Number.isInteger(octave)) {
    throw new Error("Invalid string target");
  }
  const midi = (octave + 1) * 12 + noteIndex;
  return {
    id,
    stringNumber,
    note,
    octave,
    midi,
    frequency: frequencyForMidi(midi),
  };
}

export function createTuning(id, name, notes, kind = "preset") {
  return {
    id,
    name,
    kind,
    strings: notes.map(([note, octave], index) =>
      createStringTarget(`${id}-${index + 1}`, note, octave, 6 - index),
    ),
  };
}

export const BUILT_IN_TUNINGS = [
  createTuning("standard", "标准", [["E", 2], ["A", 2], ["D", 3], ["G", 3], ["B", 3], ["E", 4]]),
  createTuning("drop-d", "Drop D", [["D", 2], ["A", 2], ["D", 3], ["G", 3], ["B", 3], ["E", 4]]),
  createTuning("d-standard", "D Standard", [["D", 2], ["G", 2], ["C", 3], ["F", 3], ["A", 3], ["D", 4]]),
  createTuning("open-g", "Open G", [["D", 2], ["G", 2], ["D", 3], ["G", 3], ["B", 3], ["D", 4]]),
  createTuning("open-d", "Open D", [["D", 2], ["A", 2], ["D", 3], ["F♯", 3], ["A", 3], ["D", 4]]),
];

export const NOTE_OPTIONS = NOTE_NAMES;

export function nearestStringTarget(tuning, frequency) {
  return tuning.strings.reduce((best, target) => {
    const distance = Math.abs(centsBetween(frequency, target.frequency));
    return distance < best.distance ? { target, distance } : best;
  }, { target: tuning.strings[0], distance: Infinity });
}

export function selectAutomaticTarget(tuning, frequency, previousTargetId, hysteresis = 18) {
  const closest = nearestStringTarget(tuning, frequency);
  const previous = tuning.strings.find((item) => item.id === previousTargetId);
  if (!previous) return closest.target;
  const previousDistance = Math.abs(centsBetween(frequency, previous.frequency));
  return previousDistance <= closest.distance + hysteresis ? previous : closest.target;
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function rmsForBuffer(buffer) {
  let squaredSum = 0;
  for (let index = 0; index < buffer.length; index += 1) squaredSum += buffer[index] ** 2;
  return Math.sqrt(squaredSum / buffer.length);
}

export function updateAdaptiveNoiseFloor(noiseFloor, rms, options = {}) {
  const initialFloor = options.initialFloor ?? 0.004;
  const maximumFloor = options.maximumFloor ?? 0.08;
  const risingRate = options.risingRate ?? 0.18;
  const fallingRate = options.fallingRate ?? 0.025;
  const currentFloor = Number.isFinite(noiseFloor) && noiseFloor > 0 ? noiseFloor : initialFloor;
  const target = Math.max(0, Math.min(maximumFloor, rms));
  const rate = target > currentFloor ? risingRate : fallingRate;
  return currentFloor + (target - currentFloor) * rate;
}

export function adaptiveSilenceThreshold(noiseFloor, options = {}) {
  const minimum = options.minimum ?? 0.008;
  const maximum = options.maximum ?? 0.08;
  const multiplier = options.multiplier ?? 2.4;
  return Math.max(minimum, Math.min(maximum, noiseFloor * multiplier));
}

// The noise floor may only learn from genuinely quiet frames. A loud frame
// without a pitch is usually a real string that failed the clarity or
// stability gate; feeding its RMS into the floor inflates the silence
// threshold until genuine plucks are muted, and the slow falling rate makes
// the engine unresponsive for seconds afterwards.
export function learnNoiseFloorFromFrame(noiseFloor, rms, options = {}) {
  if (rms >= adaptiveSilenceThreshold(noiseFloor, options)) return noiseFloor;
  return updateAdaptiveNoiseFloor(noiseFloor, rms, options);
}

export function hasStablePitchFrequencies(frequencies, requiredFrames = 3, maximumCents = 35) {
  if (frequencies.length < requiredFrames) return false;
  const recent = frequencies.slice(-requiredFrames);
  const center = median(recent);
  return center !== null && recent.every((frequency) => (
    frequency > 0 && Math.abs(centsBetween(frequency, center)) <= maximumCents
  ));
}

export function isTrustedReadingExpired(lastTrustedAt, timestamp, holdMs = TRUSTED_READING_HOLD_MS) {
  return timestamp - lastTrustedAt > holdMs;
}

export function detectPitchAutoCorrelation(buffer, sampleRate, options = {}) {
  const minFrequency = options.minFrequency ?? GUITAR_MIN_FREQUENCY;
  const maxFrequency = options.maxFrequency ?? GUITAR_MAX_FREQUENCY;
  const threshold = options.clarityThreshold ?? 0.72;

  const rms = options.rms ?? rmsForBuffer(buffer);
  if (rms < (options.silenceThreshold ?? 0.008)) return null;

  const minLag = Math.max(2, Math.floor(sampleRate / maxFrequency));
  const maxLag = Math.min(buffer.length - 2, Math.ceil(sampleRate / minFrequency));
  let bestLag = -1;
  let bestCorrelation = -Infinity;
  const correlations = new Float32Array(maxLag + 1);

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let numerator = 0;
    let leftEnergy = 0;
    let rightEnergy = 0;
    const end = buffer.length - lag;
    for (let index = 0; index < end; index += 1) {
      const left = buffer[index];
      const right = buffer[index + lag];
      numerator += left * right;
      leftEnergy += left * left;
      rightEnergy += right * right;
    }
    const correlation = numerator / Math.sqrt(leftEnergy * rightEnergy + Number.EPSILON);
    correlations[lag] = correlation;
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }

  if (bestLag < 0 || bestCorrelation < threshold) return null;
  // The global peak can be a multiple of the fundamental period (especially
  // for nearly pure tones). Use the first confident local peak instead.
  let candidateLag = -1;
  for (let lag = minLag + 1; lag < maxLag; lag += 1) {
    if (
      correlations[lag] >= threshold
      && correlations[lag] >= correlations[lag - 1]
      && correlations[lag] >= correlations[lag + 1]
    ) {
      candidateLag = lag;
      break;
    }
  }
  if (candidateLag < 0) candidateLag = bestLag;
  const candidateCorrelation = correlations[candidateLag];
  const previous = correlations[candidateLag - 1] ?? candidateCorrelation;
  const next = correlations[candidateLag + 1] ?? candidateCorrelation;
  const denominator = previous - 2 * candidateCorrelation + next;
  const adjustment = Math.abs(denominator) > Number.EPSILON
    ? 0.5 * (previous - next) / denominator
    : 0;
  const lag = candidateLag + Math.max(-0.5, Math.min(0.5, adjustment));
  const frequency = sampleRate / lag;
  if (frequency < minFrequency || frequency > maxFrequency * 1.08) return null;
  return { frequency, clarity: candidateCorrelation, rms };
}

export function isCustomTuning(value) {
  return Boolean(
    value
      && typeof value.id === "string"
      && typeof value.name === "string"
      && Array.isArray(value.strings)
      && value.strings.length === 6
      && value.strings.every((item) => NOTE_NAMES.includes(item.note) && Number.isInteger(item.octave)),
  );
}

export function normalizeCustomTuning(value) {
  if (!isCustomTuning(value)) return null;
  return createTuning(value.id, value.name.slice(0, 24), value.strings.map((item) => [item.note, item.octave]), "custom");
}

function hasPortableTuningShape(value) {
  return Boolean(
    value
      && typeof value.name === "string"
      && Array.isArray(value.strings)
      && value.strings.length === 6
      && value.strings.every((item) => NOTE_NAMES.includes(item.note) && Number.isInteger(item.octave)),
  );
}

export function normalizeImportedTunings(value) {
  const candidates = Array.isArray(value)
    ? value
    : Array.isArray(value?.tunings)
      ? value.tunings
      : [value];
  return candidates
    .filter(hasPortableTuningShape)
    .map((item) => ({
      name: item.name.trim().slice(0, 24) || "导入的调弦",
      strings: item.strings.map(({ note, octave }) => ({ note, octave })),
    }));
}

export function portableTuning(tuning) {
  return {
    format: "web-tune/tuning",
    version: 1,
    tunings: [{
      name: tuning.name,
      strings: tuning.strings.map(({ note, octave }) => ({ note, octave })),
    }],
  };
}
