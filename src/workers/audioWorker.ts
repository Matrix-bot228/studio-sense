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
function hzToBin(hz: number, fftSize: number, sampleRate: number): number { return Math.floor((hz / sampleRate) * fftSize); }
function getBalanceVerdict(low: number, mid: number, high: number): string {
  if (low > 44) return 'Boomy low-end emphasis (rough estimate).';
  if (low < 22) return 'Thin low-end weight (rough estimate).';
  if (high > 28) return 'Bright / potentially sharp highs (rough estimate).';
  if (high < 12) return 'Dull top-end (rough estimate).';
  if (mid < 36) return 'Midrange feels recessed (rough estimate).';
  return 'Spectral balance appears reasonably balanced (rough estimate).';
}

function buildProblemMarkers(result: AnalysisResult): ProblemMarker[] {
  const durationSec = result.durationSec ?? 0;
  if (!(durationSec > 0)) return [];
  const candidates = [
    { active: (result.lufsEstimate ?? 0) < -18, label: 'Too quiet → add gain', color: 'red' as const },
    { active: (result.rmsDb ?? 0) < -20, label: 'Weak signal → normalize', color: 'yellow' as const },
    { active: (result.channels ?? 0) === 1, label: 'Mono source detected → check if this is an intentional stem', color: 'blue' as const },
    { active: (result.lowPercent ?? 100) < 20, label: 'Thin sound → boost bass', color: 'yellow' as const }
  ];
  const slots = [0.1, 0.3, 0.5, 0.7];
  return candidates.filter((c) => c.active).map((c, i) => ({ id: `auto-${i}`, timeSec: durationSec * slots[i], label: c.label, severity: 'high', explanation: 'Auto-generated from whole-track analysis.', color: c.color, estimated: true, kind: 'estimated' }));
}

function analyzeRange(channelsData: Float32Array[], sampleRate: number, startSec: number, endSec: number): AnalysisResult {
  const length = channelsData[0]?.length ?? 0;
  const numberOfChannels = channelsData.length;
  const duration = sampleRate > 0 ? length / sampleRate : 0;
  const start = clamp(Math.floor(startSec * sampleRate), 0, Math.max(length - 1, 0));
  const end = clamp(Math.floor(endSec * sampleRate), start + 1, length);
  const sectionLen = Math.max(end - start, 1);

  let peak = 0; let rmsAccumulator = 0; let sampleCount = 0; let clippingCount = 0;
  const mono = new Float32Array(sectionLen);
  const chunkSize = 32_768;
  for (let offset = 0; offset < sectionLen; offset += chunkSize) {
    const chunkEnd = Math.min(offset + chunkSize, sectionLen);
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
  const lowEnd = hzToBin(250, fftSize, sampleRate);
  const midEnd = hzToBin(4000, fftSize, sampleRate);
  let low = 0; let mid = 0; let high = 0;
  for (let i = 0; i < frequencyBins.length; i += 1) {
    const v = frequencyBins[i] ?? 0;
    if (i <= lowEnd) low += v; else if (i <= midEnd) mid += v; else high += v;
  }
  const totalBand = Math.max(low + mid + high, Number.EPSILON);
  const lowPercent = (low / totalBand) * 100;
  const midPercent = (mid / totalBand) * 100;
  const highPercent = (high / totalBand) * 100;
  const lufsEstimate = rmsDb - 0.7;
  const loudnessDelta = lufsEstimate - TARGET_LUFS;
  let score = 100;
  score -= clamp(Math.abs(peakDb - SAFE_PEAK_DBFS), 0, 20) * 1.3;
  score -= clamp(Math.abs(loudnessDelta), 0, 12) * 2;
  score -= clamp(clippingCount / 500, 0, 25);
  score -= clamp(Math.abs(lowPercent - 30) / 2, 0, 15);
  score -= clamp(Math.abs(highPercent - 18) / 2, 0, 15);
  score = clamp(score, 0, 100);
  let loudnessVerdict = `On target. LUFS estimate is within ±1 dB of ${TARGET_LUFS} LUFS.`;
  if (loudnessDelta > 1) loudnessVerdict = `Too loud by about ${loudnessDelta.toFixed(1)} dB. Lower the master level a little, then listen again to keep it clean.`;
  if (loudnessDelta < -1) loudnessVerdict = `Too quiet by about ${Math.abs(loudnessDelta).toFixed(1)} dB. Raise the volume slowly, then check that the peak still stays below -1 dB.`;
  const peakSafetyVerdict = peakDb < SAFE_PEAK_DBFS ? 'Safe peak headroom.' : `Peak is above safe target by ${(peakDb - SAFE_PEAK_DBFS).toFixed(1)} dB. Set your limiter/output so the loudest parts stay below -1 dB.`;
  const clippingVerdict = clippingCount > 0
    ? `Clipping risk detected (${clippingCount} clipped samples).`
    : (peakDb > SAFE_PEAK_DBFS - 0.2
      ? 'No clipping detected yet, but the loudest parts are very close to distortion. Keep peaks below -1 dB to stay safe.'
      : 'No clipping detected in sample data.');
  let readiness: ReadinessCategory = 'Release Ready';
  if (clippingCount > 0 || peakDb >= -0.2 || Math.abs(loudnessDelta) > 4) readiness = 'Problem Area';
  else if (Math.abs(loudnessDelta) > 1.5 || peakDb > SAFE_PEAK_DBFS || lowPercent > 44 || highPercent < 10) readiness = 'Needs Work';
  let masteringSuggestion = 'Minor polish only. Keep headroom and compare against references.';
  if (readiness === 'Needs Work') masteringSuggestion = 'Adjust gain staging and EQ balance, then re-check loudness and peaks.';
  if (readiness === 'Problem Area') masteringSuggestion = 'Reduce limiting, fix clipping/ceiling, and rebalance tone before release.';
  return { durationSec: endSec - startSec || duration, sampleRate, channels: numberOfChannels, peakDb, rmsDb, clippingCount, lowPercent, midPercent, highPercent, lufsEstimate, score, loudnessVerdict, peakSafetyVerdict, clippingVerdict, balanceVerdict: getBalanceVerdict(lowPercent, midPercent, highPercent), masteringSuggestion, readiness };
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
