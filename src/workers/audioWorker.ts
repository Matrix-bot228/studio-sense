/// <reference lib="webworker" />

type ReadinessCategory = 'Release Ready' | 'Needs Work' | 'Problem Area';
type ConfidenceLevel = 'High' | 'Medium' | 'Low';

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
  bandPercents?: Record<string, number>;
  confidence?: ConfidenceLevel;
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
const QUICK_ANALYSIS_TARGET_WINDOWS = 48;
const QUICK_ANALYSIS_WINDOW_SEC = 2.5;

function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }

function computeBandPowers(magnitudes: Float32Array, sampleRate: number, fftSize: number) {
  const bands = { sub: 0, bass: 0, lowMids: 0, mids: 0, presence: 0, air: 0 };
  for (let i = 1; i < magnitudes.length; i += 1) {
    const hz = (i * sampleRate) / fftSize;
    const p = magnitudes[i] ?? 0;
    if (hz < 20) continue;
    if (hz < 60) bands.sub += p;
    else if (hz < 150) bands.bass += p;
    else if (hz < 400) bands.lowMids += p;
    else if (hz < 2000) bands.mids += p;
    else if (hz < 5000) bands.presence += p;
    else if (hz >= 8000 && hz < 12000) bands.air += p;
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
  const mono = new Float32Array(sectionLen);
  for (let i = 0; i < sectionLen; i += 1) {
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

  let sumSub = 0; let sumBass = 0; let sumLowMids = 0; let sumMids = 0; let sumPresence = 0; let sumAir = 0;
  const lufsFrames: number[] = [];
  for (let f = 0; f < frameCount; f += 1) {
    const pos = Math.min(f * hop, Math.max(0, mono.length - fftSize));
    const mags = runDftWindowed(mono, fftSize, pos);
    const b = computeBandPowers(mags, sampleRate, fftSize);
    sumSub += b.sub; sumBass += b.bass; sumLowMids += b.lowMids; sumMids += b.mids; sumPresence += b.presence; sumAir += b.air;
    let frameEnergy = 0;
    for (let i = 0; i < fftSize; i += 1) { const s = mono[pos + i] ?? 0; frameEnergy += s * s; }
    const frameRms = Math.sqrt(frameEnergy / fftSize);
    lufsFrames.push(frameRms > 0 ? 20 * Math.log10(frameRms) - 0.7 : -120);
  }

  const totalBand = Math.max(sumSub + sumBass + sumLowMids + sumMids + sumPresence + sumAir, Number.EPSILON);
  const bandPercents = {
    sub: (sumSub / totalBand) * 100,
    bass: (sumBass / totalBand) * 100,
    lowMids: (sumLowMids / totalBand) * 100,
    mids: (sumMids / totalBand) * 100,
    presence: (sumPresence / totalBand) * 100,
    air: (sumAir / totalBand) * 100
  };
  const lowPercent = bandPercents.sub + bandPercents.bass + bandPercents.lowMids;
  const midPercent = bandPercents.mids + bandPercents.presence;
  const highPercent = bandPercents.air;

  const bassMasking = bandPercents.bass > 22 && bandPercents.lowMids > 20;
  const muddyMids = bandPercents.lowMids > 24;
  const harshUpperMids = bandPercents.presence > 26;
  const dullHighs = bandPercents.air < 8;
  const thinMix = (bandPercents.sub + bandPercents.bass) < 16;
  const lowHighImbalance = Math.abs(lowPercent - (midPercent + highPercent)) > 22;

  const dynSpread = Math.max(...lufsFrames) - Math.min(...lufsFrames);
  const confidence: ConfidenceLevel = frameCount > 120 && sectionLen / sampleRate > 30 ? 'High' : frameCount > 24 ? 'Medium' : 'Low';

  const profile = harshUpperMids ? 'Harsh upper-mid mix' : bassMasking ? 'Warm but muddy' : dullHighs && thinMix ? 'Dark vintage tone' : dullHighs ? 'Bass-heavy modern master' : thinMix ? 'Bright and thin' : lowHighImbalance ? 'Bass-heavy modern master' : 'Clean balanced mix';

  const loudnessDelta = lufsEstimate - TARGET_LUFS;
  let suggestion = `${profile}. `;
  if (bassMasking || muddyMids) suggestion += 'Use subtractive EQ in 120–350 Hz before adding loudness; avoid pushing limiter early.';
  else if (dullHighs) suggestion += 'Try a gentle high shelf around 8–12 kHz and stop before cymbals or vocals get brittle.';
  else if (harshUpperMids) suggestion += 'Control 2–5 kHz peaks with broad cuts or dynamic EQ before final limiting.';
  else if (thinMix) suggestion += 'Rebuild low-end fundamentals first, then refine brightness with small high-shelf moves.';
  else suggestion += 'Proceed with small level-matched EQ moves and conservative final limiting.';

  let score = 100 - clamp(Math.abs(loudnessDelta) * 2.0, 0, 26) - clamp(Math.max(0, bandPercents.lowMids - 24) * 1.4, 0, 18) - clamp(Math.max(0, bandPercents.presence - 26) * 1.2, 0, 16) - clamp(Math.max(0, 8 - bandPercents.air) * 1.6, 0, 12) - clamp(Math.max(0, 5 - dynSpread) * 2, 0, 14);
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
    bandPercents,
    confidence,
    lufsEstimate,
    score,
    loudnessVerdict: loudnessDelta > 1 ? `Integrated loudness is ${loudnessDelta.toFixed(1)} dB above target.` : loudnessDelta < -1.2 ? `Integrated loudness is ${Math.abs(loudnessDelta).toFixed(1)} dB below target.` : 'Integrated loudness is close to target.',
    peakSafetyVerdict: peakDb < SAFE_PEAK_DBFS ? 'Peak headroom is within a safe mastering zone.' : `Peak exceeds safe ceiling by ${(peakDb - SAFE_PEAK_DBFS).toFixed(1)} dB.`,
    clippingVerdict: clippingCount > 0 ? `Clipping detected (${clippingCount} clipped samples).` : 'No clipping detected in analyzed audio.',
    balanceVerdict: `Spectrum profile: ${profile}. Confidence: ${confidence}.`,
    masteringSuggestion: suggestion,
    readiness
  };

  return { result, debug: { bandEnergy: { sub: sumSub, bass: sumBass, lowMids: sumLowMids, mids: sumMids, presence: sumPresence, air: sumAir }, bandPercents, detections: { bassMasking, muddyMids, harshUpperMids, dullHighs, thinMix, lowHighImbalance }, loudness: { lufsEstimate, frameSpreadDb: dynSpread }, profileDecision: profile, frameCount } };
}



function analyzeQuick(channelsData: Float32Array[], sampleRate: number, durationSec: number): { result: AnalysisResult; debug: Record<string, unknown> } {
  const totalSamples = channelsData[0]?.length ?? 0;
  const windowSec = Math.min(QUICK_ANALYSIS_WINDOW_SEC, Math.max(durationSec / 4, 0.8));
  const windowCount = Math.min(QUICK_ANALYSIS_TARGET_WINDOWS, Math.max(8, Math.floor(durationSec / Math.max(windowSec, 0.8))));
  const strideSec = durationSec / windowCount;

  const partials: AnalysisResult[] = [];
  const debugWindows: Array<{ startSec: number; endSec: number }> = [];

  for (let i = 0; i < windowCount; i += 1) {
    const center = (i + 0.5) * strideSec;
    const startSec = clamp(center - windowSec / 2, 0, Math.max(durationSec - 0.1, 0));
    const endSec = clamp(startSec + windowSec, startSec + 0.1, durationSec);
    const { result } = analyzeRange(channelsData, sampleRate, startSec, endSec);
    partials.push(result);
    debugWindows.push({ startSec, endSec });
  }

  const avg = (vals: number[]) => vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : 0;
  const peakDb = Math.max(...partials.map((p) => p.peakDb ?? -Infinity));
  const clippingCount = partials.reduce((sum, p) => sum + (p.clippingCount ?? 0), 0);

  const merged: AnalysisResult = {
    ...partials[Math.floor(partials.length / 2)],
    durationSec,
    sampleRate,
    channels: channelsData.length,
    peakDb,
    rmsDb: avg(partials.map((p) => p.rmsDb ?? -120)),
    clippingCount,
    lowPercent: avg(partials.map((p) => p.lowPercent ?? 0)),
    midPercent: avg(partials.map((p) => p.midPercent ?? 0)),
    highPercent: avg(partials.map((p) => p.highPercent ?? 0)),
    lufsEstimate: avg(partials.map((p) => p.lufsEstimate ?? -120)),
    confidence: durationSec >= 120 ? 'Medium' : 'Low',
    clippingVerdict: clippingCount > 0 ? `Possible clipping in sampled windows (${clippingCount} clipped samples).` : 'No clipping detected in sampled windows.',
    balanceVerdict: `${partials[0]?.balanceVerdict ?? 'Spectrum profile estimated from quick scan.'} (quick estimate)`,
  };

  return {
    result: merged,
    debug: { mode: 'quick', totalSamples, windowCount, windowSec, debugWindows }
  };
}
function buildProblemMarkers(_result: AnalysisResult): ProblemMarker[] { return []; }

self.onmessage = (event: MessageEvent) => {
  const { type, payload, requestId } = event.data;
  try {
    if (type === 'analyze') {
      const { channels, sampleRate, durationSec } = payload;
      self.postMessage({ type: 'stage', stage: 'Reading audio', requestId });
      self.postMessage({ type: 'stage', stage: 'Quick scan', requestId });
      const { result, debug } = analyzeQuick(channels, sampleRate, durationSec);
      self.postMessage({ type: 'stage', stage: 'Checking loudness', requestId });
      self.postMessage({ type: 'stage', stage: 'Checking bass / mids / highs', requestId });
      self.postMessage({ type: 'stage', stage: 'Building fix plan', requestId });
      console.log('[StudioSense][debug]', debug);
      const markers = buildProblemMarkers(result);
      self.postMessage({ type: 'stage', stage: 'Analysis complete', requestId });
      self.postMessage({ type: 'done', result, markers, debug, isLargeFile: (channels[0]?.length ?? 0) > LARGE_FILE_SAMPLES, requestId });
      return;
    }
    if (type === 'analyzeSection') {
      const { channels, sampleRate, startSec, endSec } = payload;
      const { result: sectionResult, debug } = analyzeRange(channels, sampleRate, startSec, endSec);
      console.log('[StudioSense][section-debug]', debug);
      self.postMessage({ type: 'sectionDone', sectionResult, debug, requestId });
      return;
    }
    self.postMessage({ type: 'error', error: `Unknown worker request type: ${String(type)}`, requestId });
  } catch (error) {
    self.postMessage({ type: 'error', error: error instanceof Error ? error.message : 'Unknown analysis failure', requestId });
  }
};
