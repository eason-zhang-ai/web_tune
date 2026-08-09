export const A4_FREQUENCY = 440;
export const IN_TUNE_CENTS = 5;

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

export function detectPitchAutoCorrelation(buffer, sampleRate, options = {}) {
  const minFrequency = options.minFrequency ?? 70;
  const maxFrequency = options.maxFrequency ?? 420;
  const threshold = options.clarityThreshold ?? 0.72;

  let squaredSum = 0;
  for (let index = 0; index < buffer.length; index += 1) squaredSum += buffer[index] ** 2;
  const rms = Math.sqrt(squaredSum / buffer.length);
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
