/// <reference lib="webworker" />

type ReadinessCategory = 'Release Ready' | 'Needs Work' | 'Problem Area';

type AnalysisResult = {
  durationSec?: number | null;
  sampleRate?: number | null;
  channels?: number | null;
  peakDb?: number | null;
  rmsDb?: number | null;
  clippingCount?: number | null;
  lowPercent?: number | null;
  midPercent?: number | null;
  highPercent?: number | null;
  lufsEstimate?: number | null;
  score?: number | null;
  loudnessVerdict?: string;
  peakSafetyVerdict?: string;
  clippingVerdict?: string;
  balanceVerdict?: string;
  masteringSuggestion?: string;
  readiness?: ReadinessCategory;
};

type ProblemMarker = {
  id: string;
  timeSec: number;
  label: string;
  severity: 'low' | 'medium' | 'high';
  explanation: string;
  color: 'red' | 'yellow' | 'blue' | 'purple';
  estimated: boolean;
  kind: 'estimated' | 'user';
};

const TARGET_LUFS = -14;
const SAFE_PEAK_DBFS = -1;
const LARGE_FILE_SAMPLES = 44_100 * 60 * 6;

function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
function confidenceText(label: string, score: number): string { return `${label} (${Math.round(clamp(score, 0, 1) * 100)}% confidence).`; }

function computeBandPowers(magnitudes: Float32Array, sampleRate: number, fftSize: number) {
  const bands = { sub: 0, bass: 0, lowMids: 0, mids: 0, highs: 0, air: 0 };
  for (let i = 1; i < magnitudes.length; i += 1) {
    const hz = (i * sampleRate) / fftSize;
    const p = magnitudes[i] ?? 0;
    if (hz < 20) continue;
    if (hz < 60) bands.sub += p;
    else if (hz < 200) bands.bass += p;
    else if (hz < 600) bands.lowMids += p;
    else if (hz < 2000) bands.mids += p;
    else if (hz < 8000) bands.highs += p;
    else bands.air += p;
  }
  return bands;
}

function runDftWindowed(signal: Float32Array, fftSize: number, start: number): Float32Array {
  const out = new Float32Array(fftSize / 2);
  for (let k = 0; k < out.length; k += 1) {
    let re = 0; let im = 0;
    for (let n = 0; n < fftSize; n += 1) {
      const x = signal[start + n] ?? 0;
      const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (fftSize - 1));
      const phase = (2 * Math.PI * k * n) / fftSize;
      re += x * win * Math.cos(phase); im -= x * win * Math.sin(phase);
    }
    out[k] = re * re + im * im;
  }
  return out;
}

function analyzeRange(channelsData: Float32Array[], sampleRate: number, startSec: number, endSec: number): { result: AnalysisResult; debug: Record<string, unknown> } {
  const length = channelsData[0]?.length ?? 0;
  const numberOfChannels = channelsData.length;
  const start = clamp(Math.floor(startSec * sampleRate), 0, Math.max(length - 1, 0));
  const end = clamp(Math.floor(endSec * sampleRate), start + 1, length);
  const sectionLen = Math.max(end - start, 1);

  let peak = 0; let rmsAccumulator = 0; let sampleCount = 0; let clippingCount = 0;
  let sideEnergy = 0; let midEnergy = 0;
  const mono = new Float32Array(sectionLen);

  for (let i = 0; i < sectionLen; i += 1) {
    const left = channelsData[0]?.[start + i] ?? 0;
    const right = channelsData[1]?.[start + i] ?? left;
    const midSample = (left + right) * 0.5;
    const sideSample = (left - right) * 0.5;
    midEnergy += midSample * midSample;
    sideEnergy += sideSample * sideSample;

    for (let channel = 0; channel < numberOfChannels; channel += 1) {
      const sample = channelsData[channel]?.[start + i] ?? 0;
      const absSample = Math.abs(sample);
      if (absSample > peak) peak = absSample;
      if (absSample >= 0.999) clippingCount += 1;
      rmsAccumulator += sample * sample;
      mono[i] += sample / numberOfChannels;
      sampleCount += 1;
    }
  }

  const rms = Math.sqrt(rmsAccumulator / Math.max(sampleCount, 1));
  const peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  const lufsEstimate = rmsDb - 0.7;
  const fftSize = 2048;
  const hop = 1024;
  const frameCount = Math.max(1, Math.floor((mono.length - fftSize) / hop) + 1);

  let sumSub = 0; let sumBass = 0; let sumLowMids = 0; let sumMids = 0; let sumHighs = 0; let sumAir = 0;
  const lufsFrames: number[] = [];
  for (let f = 0; f < frameCount; f += 1) {
    const pos = Math.min(f * hop, Math.max(0, mono.length - fftSize));
    const mags = runDftWindowed(mono, fftSize, pos);
    const b = computeBandPowers(mags, sampleRate, fftSize);
    sumSub += b.sub; sumBass += b.bass; sumLowMids += b.lowMids; sumMids += b.mids; sumHighs += b.highs; sumAir += b.air;
    let frameEnergy = 0;
    for (let i = 0; i < fftSize; i += 1) { const s = mono[pos + i] ?? 0; frameEnergy += s * s; }
    const frameRms = Math.sqrt(frameEnergy / fftSize);
    lufsFrames.push(frameRms > 0 ? 20 * Math.log10(frameRms) - 0.7 : -120);
  }

  const totalBand = Math.max(sumSub + sumBass + sumLowMids + sumMids + sumHighs + sumAir, Number.EPSILON);
  const lowPercent = ((sumSub + sumBass + sumLowMids) / totalBand) * 100;
  const midPercent = (sumMids / totalBand) * 100;
  const highPercent = ((sumHighs + sumAir) / totalBand) * 100;

  const bassToMids = (sumSub + sumBass) / Math.max(sumMids, Number.EPSILON);
  const highsToLowMids = (sumHighs + sumAir) / Math.max(sumLowMids, Number.EPSILON);
  const dynSpread = Math.max(...lufsFrames) - Math.min(...lufsFrames);

  const profile = bassToMids > 1.3 ? 'Low-end heavy' : highsToLowMids > 1.4 ? 'Bright-leaning' : dynSpread > 9 ? 'Dynamic wide' : 'Balanced commercial';
  const reason = `b/m=${bassToMids.toFixed(2)}, h/lm=${highsToLowMids.toFixed(2)}, dyn=${dynSpread.toFixed(1)}dB`;

  let masteringSuggestion = `${profile} profile detected. `;
  if (bassToMids > 1.35) masteringSuggestion += 'Low end dominates mids; trim bass or add mid clarity.';
  else if (highsToLowMids > 1.45) masteringSuggestion += 'Top end outweighs body; soften highs or support low-mids.';
  else if (dynSpread < 5 && lufsEstimate > -12) masteringSuggestion += 'Dense dynamics at loud level; reduce limiting for movement.';
  else masteringSuggestion += 'Tonal proportions are stable; focus on taste-level refinements.';

  const loudnessDelta = lufsEstimate - TARGET_LUFS;
  let score = 100 - clamp(Math.abs(loudnessDelta) * 2.0, 0, 26) - clamp(Math.abs(bassToMids - 1) * 18, 0, 22) - clamp(Math.abs(highsToLowMids - 1) * 14, 0, 18) - clamp(Math.max(0, 5 - dynSpread) * 2, 0, 14);
  score = clamp(score, 0, 100);

  const readiness: ReadinessCategory = score < 60 || clippingCount > 0 ? 'Problem Area' : score < 78 ? 'Needs Work' : 'Release Ready';

  const result: AnalysisResult = {
    durationSec: (end - start) / sampleRate,
    sampleRate,
    channels: numberOfChannels,
    peakDb,
    rmsDb,
    clippingCount,
    lowPercent,
    midPercent,
    highPercent,
    lufsEstimate,
    score,
    loudnessVerdict: loudnessDelta > 1 ? `Running hot by ${loudnessDelta.toFixed(1)} dB.` : loudnessDelta < -1.2 ? `About ${Math.abs(loudnessDelta).toFixed(1)} dB under target.` : 'Loudness is close to target.',
    peakSafetyVerdict: peakDb < SAFE_PEAK_DBFS ? 'Peak headroom is in a safe zone.' : `Peak exceeds safe ceiling by ${(peakDb - SAFE_PEAK_DBFS).toFixed(1)} dB.`,
    clippingVerdict: clippingCount > 0 ? `Clipping risk detected (${clippingCount} clipped samples).` : 'No clipping detected in sample data.',
    balanceVerdict: confidenceText(`Relative balance ${profile.toLowerCase()}`, 0.68),
    masteringSuggestion,
    readiness
  };

  return { result, debug: { bandEnergy: { sub: sumSub, bass: sumBass, lowMids: sumLowMids, mids: sumMids, highs: sumHighs, air: sumAir }, ratios: { bassToMids, highsToLowMids }, loudness: { lufsEstimate, frameSpreadDb: dynSpread }, profileDecision: profile, finalReason: reason, frameCount } };
}

function buildProblemMarkers(_result: AnalysisResult): ProblemMarker[] { return []; }

self.onmessage = (event: MessageEvent) => {
  const { type, payload, requestId } = event.data;
  if (type === 'analyze') {
    const { channels, sampleRate, durationSec } = payload;
    self.postMessage({ type: 'stage', stage: 'Reading full track waveform', requestId });
    const { result, debug } = analyzeRange(channels, sampleRate, 0, durationSec);
    console.log('[StudioSense][debug]', debug);
    const markers = buildProblemMarkers(result);
    self.postMessage({ type: 'done', result, markers, debug, isLargeFile: (channels[0]?.length ?? 0) > LARGE_FILE_SAMPLES, requestId });
  }
  if (type === 'analyzeSection') {
    const { channels, sampleRate, startSec, endSec } = payload;
    const { result: sectionResult, debug } = analyzeRange(channels, sampleRate, startSec, endSec);
    console.log('[StudioSense][section-debug]', debug);
    self.postMessage({ type: 'sectionDone', sectionResult, debug, requestId });
  }
};
