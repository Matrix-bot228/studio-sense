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
  soundProfile?: string;
  sourceQuality?: {
    isLowFidelitySource: boolean;
    isCompressedSource: boolean;
    isMono: boolean;
    isNotRecommended: boolean;
    sourceType: string;
    channels: number;
    recommendation: string;
  };
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
const QUICK_MAX_ANALYSIS_SAMPLES = 40_000;
const QUICK_MAX_SPECTRUM_FRAMES = 80;

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
  const numberOfChannels = channelsData.length;
  if (!totalSamples || !numberOfChannels) {
    return { result: { durationSec, sampleRate, channels: numberOfChannels }, debug: { mode: 'quick-empty' } };
  }

  const frameStep = Math.max(128, Math.floor(totalSamples / QUICK_MAX_ANALYSIS_SAMPLES));
  const spectrumWindow = 1024;
  const maxSpectrumFrames: number = QUICK_MAX_SPECTRUM_FRAMES;
  const spectrumHop = Math.max(sampleRate * 2, Math.floor(totalSamples / QUICK_MAX_SPECTRUM_FRAMES));
  const sampleWindow = Math.min(totalSamples, Math.max(spectrumWindow, frameStep * 8));
  const analysisFrames = Math.max(1, Math.floor((totalSamples - sampleWindow) / frameStep) + 1);
  let peak = 0;
  let clippingCount = 0;
  let energy = 0;
  let sampleCount = 0;

  let sumSub = 0; let sumBass = 0; let sumLowMids = 0; let sumMids = 0; let sumPresence = 0; let sumAir = 0;
  let spectrumFrames = 0;

  for (let frame = 0; frame < analysisFrames; frame += 1) {
    const base = analysisFrames === 1 ? 0 : Math.floor((frame * (totalSamples - sampleWindow)) / Math.max(analysisFrames - 1, 1));
    const end = Math.min(totalSamples, base + sampleWindow);
    let mono = 0;
    for (let i = base; i < end; i += frameStep) {
      for (let ch = 0; ch < numberOfChannels; ch += 1) {
        const sample = channelsData[ch]?.[i] ?? 0;
        const absSample = Math.abs(sample);
        if (absSample > peak) peak = absSample;
        if (absSample >= 0.999) clippingCount += 1;
        energy += sample * sample;
        sampleCount += 1;
        mono += sample / numberOfChannels;
      }
    }
    void mono;
  }

  const monoForSpectrum = channelsData[0];
  const spectrumSpan = Math.max(totalSamples - spectrumWindow - 1, 0);
  for (let f = 0; f < maxSpectrumFrames; f += 1) {
    if (spectrumFrames >= maxSpectrumFrames) break;
    const pos = maxSpectrumFrames === 1 ? 0 : Math.floor((f * spectrumSpan) / Math.max(maxSpectrumFrames - 1, 1));
    if (pos + spectrumWindow >= totalSamples) break;
    const mags = runDftWindowed(monoForSpectrum, spectrumWindow, pos);
    const b = computeBandPowers(mags, sampleRate, spectrumWindow);
    sumSub += b.sub; sumBass += b.bass; sumLowMids += b.lowMids; sumMids += b.mids; sumPresence += b.presence; sumAir += b.air;
    spectrumFrames += 1;
  }

  const rms = Math.sqrt(energy / Math.max(sampleCount, 1));
  const peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  const lufsEstimate = rmsDb - 0.7;
  const totalBand = Math.max(sumSub + sumBass + sumLowMids + sumMids + sumPresence + sumAir, Number.EPSILON);
  const lowPercent = ((sumSub + sumBass + sumLowMids) / totalBand) * 100;
  const midPercent = ((sumMids + sumPresence) / totalBand) * 100;
  const highPercent = (sumAir / totalBand) * 100;

  const result: AnalysisResult = {
    durationSec,
    sampleRate,
    channels: numberOfChannels,
    peakDb,
    rmsDb,
    clippingCount,
    lowPercent,
    midPercent,
    highPercent,
    lufsEstimate,
    confidence: durationSec >= 120 ? 'Medium' : 'Low',
    loudnessVerdict: lufsEstimate > TARGET_LUFS + 1 ? `Integrated loudness is ${(lufsEstimate - TARGET_LUFS).toFixed(1)} dB above target.` : lufsEstimate < TARGET_LUFS - 1.2 ? `Integrated loudness is ${(TARGET_LUFS - lufsEstimate).toFixed(1)} dB below target.` : 'Integrated loudness is close to target.',
    peakSafetyVerdict: peakDb < SAFE_PEAK_DBFS ? 'Peak headroom is within a safe mastering zone.' : `Peak exceeds safe ceiling by ${(peakDb - SAFE_PEAK_DBFS).toFixed(1)} dB.`,
    clippingVerdict: clippingCount > 0 ? `Possible clipping in sampled frames (${clippingCount} clipped samples).` : 'No clipping detected in sampled frames.',
    balanceVerdict: 'Quick estimate: spectrum profile sampled for beginner-friendly speed.',
    masteringSuggestion: 'Quick estimate for first-pass decisions; confirm broad issues with focused manual section checks.',
    readiness: clippingCount > 0 ? 'Problem Area' : 'Needs Work'
  };

  return { result, debug: { mode: 'quick-sampled', totalSamples, frameStep, sampledFrames: Math.ceil((analysisFrames * sampleWindow) / frameStep), spectrumFrames, spectrumHop, sampleWindow, analysisFrames, maxSpectrumFrames, maxAnalysisSamples: QUICK_MAX_ANALYSIS_SAMPLES } };
}
function buildProblemMarkers(_result: AnalysisResult): ProblemMarker[] { return []; }

function buildSourceQuality(result: AnalysisResult): NonNullable<AnalysisResult['sourceQuality']> {
  const channels = result.channels ?? 2;
  const isMono = channels === 1;
  const isCompressedSource = typeof result.sampleRate === 'number' && result.sampleRate <= 32000;
  const isLowFidelitySource = Boolean(
    isMono
    || isCompressedSource
    || (result.clippingCount ?? 0) > 2
    || (typeof result.highPercent === 'number' && result.highPercent < 10)
    || (typeof result.rmsDb === 'number' && result.rmsDb < -21)
  );
  const isNotRecommended = Boolean(
    result.readiness === 'Problem Area'
    || (result.clippingCount ?? 0) > 4
    || (isCompressedSource && isMono)
  );
  const sourceType = `${isLowFidelitySource ? 'Low Fidelity Source' : 'Good Production Source'}${isCompressedSource ? ', MP3/compressed' : ', uncompressed/standard'}${isMono ? ', mono' : ', stereo'}`;
  const recommendation = isNotRecommended
    ? 'Not Recommended for mastering until source issues are fixed.'
    : isLowFidelitySource
      ? 'Needs Work before mastering for best results.'
      : 'Suitable source for mastering workflow.';
  return { isLowFidelitySource, isCompressedSource, isMono, isNotRecommended, sourceType, channels, recommendation };
}

self.onmessage = (event: MessageEvent) => {
  const { type, payload, requestId } = event.data;
  console.log('[StudioSense] worker received analyze message', type, requestId);
  try {
    if (type === 'analyze') {
      const { channels, sampleRate, durationSec } = payload;
      self.postMessage({ type: 'stage', stage: 'Reading audio', requestId });
      self.postMessage({ type: 'stage', stage: 'Quick scan', requestId });
      console.time('StudioSense worker analysis');
      const { result, debug } = analyzeQuick(channels, sampleRate, durationSec);
      const sourceQuality = buildSourceQuality(result);
      const profileFromResult = typeof result.balanceVerdict === 'string' && result.balanceVerdict.length
        ? result.balanceVerdict.replace(/^Spectrum profile:\s*/i, '').replace(/\.\s*Confidence:.*$/i, '').trim()
        : '';
      const finalResult: AnalysisResult = {
        ...result,
        sourceQuality,
        soundProfile: profileFromResult || result.soundProfile || 'Unspecified profile'
      };
      console.timeEnd('StudioSense worker analysis');
      self.postMessage({ type: 'stage', stage: 'Building result', requestId });
      console.log('[StudioSense][debug]', debug);
      const markers = buildProblemMarkers(finalResult);
      console.log('StudioSense worker done', requestId);
      console.time('StudioSense worker done');
      self.postMessage({ requestId, type: 'done', data: { result: finalResult, markers, debug } });
      console.timeEnd('StudioSense worker done');
      return;
    }
    if (type === 'analyzeSection') {
      const { channels, sampleRate, startSec, endSec } = payload;
      console.time('StudioSense worker analysis');
      const { result: sectionResult, debug } = analyzeRange(channels, sampleRate, startSec, endSec);
      console.timeEnd('StudioSense worker analysis');
      console.log('[StudioSense][section-debug]', debug);
      self.postMessage({ type: 'sectionDone', sectionResult, debug, requestId });
      return;
    }
    self.postMessage({ type: 'failed', error: `Unknown worker request type: ${String(type)}`, requestId });
  } catch (error) {
    self.postMessage({ type: 'failed', error: error instanceof Error ? error.message : String(error), requestId });
  }
};
