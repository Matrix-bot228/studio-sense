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

type TonalFingerprint = {
  profile: string;
  confidence: number;
  tags: string[];
  lowRatio: number;
  highRatio: number;
  subToHighRatio: number;
  stereoWidth: number;
  crestFactor: number;
  dynamicRangeDb: number;
};

const TARGET_LUFS = -14;
const SAFE_PEAK_DBFS = -1;
const LARGE_FILE_SAMPLES = 44_100 * 60 * 6;

function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
function hzToBin(hz: number, fftSize: number, sampleRate: number): number { return Math.floor((hz / sampleRate) * fftSize); }
function confidenceText(label: string, score: number): string { return `${label} (${Math.round(clamp(score, 0, 1) * 100)}% confidence).`; }

function getBalanceVerdict(low: number, mid: number, high: number, fingerprint: TonalFingerprint): string {
  const notes: string[] = [];

  if (fingerprint.tags.includes('muddymix')) {
    notes.push(confidenceText('Possible low-end buildup around the low mids', 0.72));
  }
  if (fingerprint.tags.includes('thinmix')) {
    notes.push(confidenceText('Thin / weak body with reduced low-end support', 0.78));
  }
  if (fingerprint.tags.includes('harshmix')) {
    notes.push(confidenceText('Upper-mid edge may sound harsh at louder playback levels', 0.74));
  }
  if (fingerprint.tags.includes('brightsharp')) {
    notes.push('The track leans bright and sharp, which helps detail but can fatigue listeners on headphones.');
  }
  if (fingerprint.tags.includes('darkwarm')) {
    notes.push('The track leans warm and bass-heavy, which suits blues styles but may slightly reduce vocal clarity on smaller speakers.');
  }
  if (fingerprint.tags.includes('vocalforward')) {
    notes.push('Vocals appear forward relative to the lows and highs, so lyric intelligibility should translate well.');
  }
  if (fingerprint.tags.includes('intentionalwarm')) {
    notes.push(confidenceText('Likely intentional warm tonal balance', 0.76));
  }

  if (notes.length === 0) {
    if (low > 42 && high < 12 && mid < 42) return 'Dark cinematic tilt with controlled top-end; verify translation on smaller speakers.';
    if (high > 30 && low < 22) return 'Modern bright tilt with lean lows; confirm the mix still feels full on larger systems.';
    return 'Spectral balance appears commercially balanced with no dominant tonal warning signs.';
  }

  return notes.slice(0, 2).join(' ');
}

function buildProblemMarkers(result: AnalysisResult): ProblemMarker[] {
  const durationSec = result.durationSec ?? 0;
  if (!(durationSec > 0)) return [];
  const low = result.lowPercent ?? 0;
  const mid = result.midPercent ?? 0;
  const high = result.highPercent ?? 0;
  const lufs = result.lufsEstimate ?? -99;
  const candidates = [
    { active: lufs < -19.5, label: 'Low-energy presentation → increase level or contrast', color: 'red' as const },
    { active: (result.peakDb ?? -99) > -0.5 && (result.clippingCount ?? 0) > 0, label: 'Overly limited section → ease limiter ceiling', color: 'purple' as const },
    { active: low > 46 && mid < 40, label: 'Possible muddy low-mid density', color: 'yellow' as const },
    { active: high > 31 && mid < 33, label: 'Sharp top-end prominence', color: 'blue' as const }
  ];
  const slots = [0.12, 0.33, 0.57, 0.79];
  return candidates.filter((c) => c.active).map((c, i) => ({ id: `auto-${i}`, timeSec: durationSec * slots[i], label: c.label, severity: 'high', explanation: `Auto-generated from whole-track analysis (L:${low.toFixed(1)} M:${mid.toFixed(1)} H:${high.toFixed(1)}).`, color: c.color, estimated: true, kind: 'estimated' }));
}

function analyzeRange(channelsData: Float32Array[], sampleRate: number, startSec: number, endSec: number): AnalysisResult {
  const length = channelsData[0]?.length ?? 0;
  const numberOfChannels = channelsData.length;
  const duration = sampleRate > 0 ? length / sampleRate : 0;
  const start = clamp(Math.floor(startSec * sampleRate), 0, Math.max(length - 1, 0));
  const end = clamp(Math.floor(endSec * sampleRate), start + 1, length);
  const sectionLen = Math.max(end - start, 1);

  let peak = 0; let rmsAccumulator = 0; let sampleCount = 0; let clippingCount = 0;
  let sideEnergy = 0; let midEnergy = 0;
  const mono = new Float32Array(sectionLen);
  const chunkSize = 32_768;
  for (let offset = 0; offset < sectionLen; offset += chunkSize) {
    const chunkEnd = Math.min(offset + chunkSize, sectionLen);
    for (let i = offset; i < chunkEnd; i += 1) {
      const left = channelsData[0]?.[start + i] ?? 0;
      const right = channelsData[1]?.[start + i] ?? left;
      const midSample = (left + right) * 0.5;
      const sideSample = (left - right) * 0.5;
      midEnergy += midSample * midSample;
      sideEnergy += sideSample * sideSample;
    }
    for (let channel = 0; channel < numberOfChannels; channel += 1) {
      const data = channelsData[channel];
      for (let i = offset; i < chunkEnd; i += 1) {
        const sample = data[start + i] ?? 0;
        const absSample = Math.abs(sample);
        if (absSample > peak) peak = absSample;
        if (absSample >= 0.999) clippingCount += 1;
        rmsAccumulator += sample * sample;
        mono[i] += sample / numberOfChannels;
      }
      sampleCount += (chunkEnd - offset);
    }
  }

  const rms = Math.sqrt(rmsAccumulator / Math.max(sampleCount, 1));
  const peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  const fftSize = Math.min(16384, 2 ** Math.floor(Math.log2(Math.max(1024, mono.length))));
  const spectrumInput = mono.slice(0, fftSize);
  const frequencyBins = new Float32Array(fftSize / 2);
  for (let k = 0; k < fftSize / 2; k += 1) {
    let re = 0; let im = 0;
    for (let n = 0; n < fftSize; n += 1) {
      const sample = spectrumInput[n] ?? 0;
      const phase = (2 * Math.PI * k * n) / fftSize;
      re += sample * Math.cos(phase); im -= sample * Math.sin(phase);
    }
    frequencyBins[k] = re * re + im * im;
  }
  const subEnd = hzToBin(120, fftSize, sampleRate);
  const lowEnd = hzToBin(280, fftSize, sampleRate);
  const lowMidEnd = hzToBin(750, fftSize, sampleRate);
  const midEnd = hzToBin(4000, fftSize, sampleRate);
  const highMidEnd = hzToBin(9000, fftSize, sampleRate);
  let sub = 0; let low = 0; let lowMid = 0; let mid = 0; let highMid = 0; let high = 0;
  for (let i = 0; i < frequencyBins.length; i += 1) {
    const v = frequencyBins[i] ?? 0;
    if (i <= subEnd) sub += v;
    if (i <= lowEnd) low += v;
    else if (i <= lowMidEnd) lowMid += v;
    else if (i <= midEnd) mid += v;
    else if (i <= highMidEnd) highMid += v;
    else high += v;
  }

  const totalBand = Math.max(low + lowMid + mid + highMid + high, Number.EPSILON);
  const lowPercent = ((low + lowMid) / totalBand) * 100;
  const midPercent = (mid / totalBand) * 100;
  const highPercent = ((highMid + high) / totalBand) * 100;

  const lufsEstimate = rmsDb - 0.7;
  const crestFactor = peakDb - rmsDb;
  const dynamicRangeDb = clamp(crestFactor + 3, 2, 20);
  const stereoWidth = sideEnergy > 0 ? clamp(sideEnergy / Math.max(midEnergy, Number.EPSILON), 0, 1.8) : 0;

  const lowRatio = (low + lowMid) / Math.max(mid + highMid + high, Number.EPSILON);
  const highRatio = (highMid + high) / Math.max(low + lowMid + mid, Number.EPSILON);
  const subToHighRatio = sub / Math.max(highMid + high, Number.EPSILON);

  const tags: string[] = [];
  const thinMixScore = clamp((0.95 - lowRatio) * 0.9 + (12 - lowPercent) * 0.03, 0, 1);
  if (thinMixScore > 0.55) tags.push('thinmix');
  const harshMixScore = clamp((highRatio - 0.58) * 1.4 + (highPercent - 34) * 0.02, 0, 1);
  if (harshMixScore > 0.58) tags.push('harshmix', 'brightsharp');
  const muddyScore = clamp((lowRatio - 1.28) * 1.1 + (52 - highPercent) * 0.015, 0, 1);
  if (muddyScore > 0.6 && highPercent > 8) tags.push('muddymix');
  const compressedScore = clamp((8.5 - crestFactor) * 0.16 + ((peakDb > -0.6 ? 1 : 0) * 0.35), 0, 1);
  if (compressedScore > 0.6) tags.push('compressedmix');
  if (compressedScore > 0.78 && lufsEstimate > -10.5) tags.push('overlimited');
  if (lowRatio > 1.2 && highRatio < 0.26) tags.push('darkwarm');
  if (highRatio > 0.62 && lowRatio < 1) tags.push('brightsharp');
  if (midPercent > 44 && lowPercent < 38 && highPercent < 26) tags.push('vocalforward');
  if (lufsEstimate < -18.8 && rmsDb < -19.5) tags.push('lowenergy');
  if (stereoWidth < 0.12 && numberOfChannels > 1) tags.push('narrowstereo');
  if (dynamicRangeDb > 13 && compressedScore < 0.4) tags.push('dynamicopen');

  const isIntentionalSoftTop = highPercent < 9 && dynamicRangeDb > 12 && compressedScore < 0.4 && lowRatio < 1.45;
  if (isIntentionalSoftTop) tags.push('intentionalwarm');

  let profile = 'Balanced commercial';
  if (tags.includes('overlimited')) profile = 'Over-compressed';
  else if (tags.includes('dynamicopen')) profile = 'Natural dynamic';
  else if (tags.includes('muddymix')) profile = 'Dark cinematic';
  else if (tags.includes('brightsharp')) profile = 'Modern bright';
  else if (tags.includes('vocalforward')) profile = 'Mid-forward';
  else if (tags.includes('thinmix')) profile = 'Thin / weak';
  else if (lowRatio > 1.22) profile = 'Bass-heavy';
  else if (isIntentionalSoftTop) profile = 'Lo-fi texture';
  else if (tags.includes('darkwarm')) profile = 'Warm vintage';

  const confidence = clamp(0.55 + Math.abs(lowRatio - 1) * 0.18 + Math.abs(highRatio - 0.35) * 0.2 + (tags.length * 0.03), 0.52, 0.96);
  const fingerprint: TonalFingerprint = { profile, confidence, tags, lowRatio, highRatio, subToHighRatio, stereoWidth, crestFactor, dynamicRangeDb };

  const loudnessDelta = lufsEstimate - TARGET_LUFS;
  let score = 100;
  score -= clamp(Math.abs(peakDb - SAFE_PEAK_DBFS), 0, 20) * 1.2;
  score -= clamp(Math.abs(loudnessDelta), 0, 12) * 1.8;
  score -= clamp(clippingCount / 500, 0, 25);
  score -= clamp(Math.abs(lowPercent - 31) / 2, 0, 14);
  score -= clamp(Math.abs(highPercent - 21) / 2, 0, 14);
  score -= compressedScore * 8;
  score = clamp(score, 0, 100);

  let loudnessVerdict = `Loudness is close to target (${TARGET_LUFS} LUFS goal).`;
  if (loudnessDelta > 1) loudnessVerdict = `Running hot by about ${loudnessDelta.toFixed(1)} dB; trim output slightly to preserve punch.`;
  if (loudnessDelta < -1.2) loudnessVerdict = `Low-energy loudness, about ${Math.abs(loudnessDelta).toFixed(1)} dB under target. Raise level carefully if needed.`;

  const peakSafetyVerdict = peakDb < SAFE_PEAK_DBFS
    ? 'Peak headroom is in a safe zone.'
    : `Peak exceeds safe ceiling by ${(peakDb - SAFE_PEAK_DBFS).toFixed(1)} dB. Ease limiter/output gain.`;

  const clippingVerdict = clippingCount > 0
    ? `Clipping risk detected (${clippingCount} clipped samples).`
    : (tags.includes('overlimited')
      ? 'No hard clipping found, but limiting density is high and may reduce musical depth.'
      : 'No clipping detected in sample data.');

  let readiness: ReadinessCategory = 'Release Ready';
  if (clippingCount > 0 || tags.includes('overlimited') || peakDb >= -0.2 || Math.abs(loudnessDelta) > 4.5) readiness = 'Problem Area';
  else if (Math.abs(loudnessDelta) > 1.8 || peakDb > SAFE_PEAK_DBFS || tags.includes('muddymix') || tags.includes('harshmix') || tags.includes('narrowstereo')) readiness = 'Needs Work';

  let masteringSuggestion = `${fingerprint.profile} profile detected (${Math.round(fingerprint.confidence * 100)}% confidence).`;
  if (tags.includes('intentionalwarm')) masteringSuggestion += ' Highs appear intentionally soft; avoid over-brightening unless translation fails.';
  if (tags.includes('overlimited')) masteringSuggestion += ' Reduce limiter drive to recover dynamics and transient shape.';
  else if (tags.includes('dynamicopen')) masteringSuggestion += ' Dynamics are open; preserve transient movement during final limiting.';
  else if (tags.includes('muddymix')) masteringSuggestion += ' Tighten 200–500 Hz gently to clear space for vocals and snare presence.';

  return {
    durationSec: endSec - startSec || duration,
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
    loudnessVerdict,
    peakSafetyVerdict,
    clippingVerdict,
    balanceVerdict: getBalanceVerdict(lowPercent, midPercent, highPercent, fingerprint),
    masteringSuggestion,
    readiness
  };
}

self.onmessage = (event: MessageEvent) => {
  const { type, payload, requestId } = event.data;
  if (type === 'analyze') {
    const { channels, sampleRate, durationSec } = payload;
    self.postMessage({ type: 'stage', stage: 'Reading waveform', requestId });
    self.postMessage({ type: 'stage', stage: 'Measuring loudness', requestId });
    const result = analyzeRange(channels, sampleRate, 0, durationSec);
    self.postMessage({ type: 'stage', stage: 'Finding problem areas', requestId });
    const markers = buildProblemMarkers(result);
    self.postMessage({ type: 'stage', stage: 'Building diagnosis', requestId });
    self.postMessage({ type: 'done', result, markers, isLargeFile: (channels[0]?.length ?? 0) > LARGE_FILE_SAMPLES, requestId });
  }
  if (type === 'analyzeSection') {
    const { channels, sampleRate, startSec, endSec } = payload;
    const sectionResult = analyzeRange(channels, sampleRate, startSec, endSec);
    self.postMessage({ type: 'sectionDone', sectionResult, requestId });
  }
};
