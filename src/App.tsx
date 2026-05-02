import { useMemo, useState, type ChangeEvent } from 'react';

type ReadinessCategory = 'Release Ready' | 'Needs Work' | 'Problem Area';
type BadgeTone = 'good' | 'warn' | 'bad' | 'info';

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

const TARGET_LUFS = -14;
const SAFE_PEAK_DBFS = -1;

function formatDb(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)} dB` : '—';
}

function formatScore(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(0)} / 100` : '—';
}

function formatNumber(value: number | null | undefined, digits = 1): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hzToBin(hz: number, fftSize: number, sampleRate: number): number {
  return Math.floor((hz / sampleRate) * fftSize);
}

function getBalanceVerdict(low: number, mid: number, high: number): string {
  if (low > 44) return 'Boomy low-end emphasis (rough estimate).';
  if (low < 22) return 'Thin low-end weight (rough estimate).';
  if (high > 28) return 'Bright / potentially sharp highs (rough estimate).';
  if (high < 12) return 'Dull top-end (rough estimate).';
  if (mid < 36) return 'Midrange feels recessed (rough estimate).';
  return 'Spectral balance appears reasonably balanced (rough estimate).';
}

async function analyzeAudioFile(file: File): Promise<AnalysisResult> {
  const arrayBuffer = await file.arrayBuffer();
  const audioContext = new AudioContext();

  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    const { sampleRate, numberOfChannels, length, duration } = audioBuffer;

    let peak = 0;
    let rmsAccumulator = 0;
    let sampleCount = 0;
    let clippingCount = 0;

    const mono = new Float32Array(length);

    for (let channel = 0; channel < numberOfChannels; channel += 1) {
      const data = audioBuffer.getChannelData(channel);
      for (let i = 0; i < data.length; i += 1) {
        const sample = data[i] ?? 0;
        const absSample = Math.abs(sample);
        if (absSample > peak) peak = absSample;
        if (absSample >= 0.999) clippingCount += 1;
        rmsAccumulator += sample * sample;
        mono[i] = (mono[i] ?? 0) + sample / numberOfChannels;
      }
      sampleCount += data.length;
    }

    const rms = Math.sqrt(rmsAccumulator / Math.max(sampleCount, 1));
    const peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
    const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;

    const fftSize = Math.min(32768, 2 ** Math.floor(Math.log2(Math.max(1024, mono.length))));
    const spectrumInput = mono.slice(0, fftSize);
    const frequencyBins = new Float32Array(fftSize / 2);

    for (let k = 0; k < fftSize / 2; k += 1) {
      let re = 0;
      let im = 0;
      for (let n = 0; n < fftSize; n += 1) {
        const sample = spectrumInput[n] ?? 0;
        const phase = (2 * Math.PI * k * n) / fftSize;
        re += sample * Math.cos(phase);
        im -= sample * Math.sin(phase);
      }
      frequencyBins[k] = re * re + im * im;
    }

    const lowEnd = hzToBin(250, fftSize, sampleRate);
    const midEnd = hzToBin(4000, fftSize, sampleRate);

    let low = 0;
    let mid = 0;
    let high = 0;

    for (let i = 0; i < frequencyBins.length; i += 1) {
      const value = frequencyBins[i] ?? 0;
      if (i <= lowEnd) low += value;
      else if (i <= midEnd) mid += value;
      else high += value;
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
    if (loudnessDelta > 1) loudnessVerdict = `Too loud by about ${loudnessDelta.toFixed(1)} dB. Reduce gain/limiter output.`;
    if (loudnessDelta < -1) loudnessVerdict = `Too quiet by about ${Math.abs(loudnessDelta).toFixed(1)} dB. Add gain/limiting.`;

    const peakSafetyVerdict = peakDb < SAFE_PEAK_DBFS
      ? `Safe peak headroom (${formatDb(peakDb)} below -1 dBFS target).`
      : `Peak is above safe target by ${(peakDb - SAFE_PEAK_DBFS).toFixed(1)} dB. Lower ceiling.`;

    const clippingVerdict = clippingCount > 0
      ? `Clipping risk detected (${clippingCount} clipped samples).`
      : 'No clipping detected in sample data.';

    const balanceVerdict = getBalanceVerdict(lowPercent, midPercent, highPercent);

    let readiness: ReadinessCategory = 'Release Ready';
    if (clippingCount > 0 || peakDb >= -0.2 || Math.abs(loudnessDelta) > 4) readiness = 'Problem Area';
    else if (Math.abs(loudnessDelta) > 1.5 || peakDb > SAFE_PEAK_DBFS || lowPercent > 44 || highPercent < 10) readiness = 'Needs Work';

    let masteringSuggestion = 'Minor polish only. Keep headroom and compare against references.';
    if (readiness === 'Needs Work') masteringSuggestion = 'Adjust gain staging and EQ balance, then re-check loudness and peaks.';
    if (readiness === 'Problem Area') masteringSuggestion = 'Reduce limiting, fix clipping/ceiling, and rebalance tone before release.';

    return {
      durationSec: duration,
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
      balanceVerdict,
      masteringSuggestion,
      readiness
    };
  } finally {
    await audioContext.close();
  }
}

function toneForReadiness(value?: ReadinessCategory): BadgeTone {
  if (value === 'Release Ready') return 'good';
  if (value === 'Needs Work') return 'warn';
  if (value === 'Problem Area') return 'bad';
  return 'info';
}

export default function App() {
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [status, setStatus] = useState<string>('Upload audio to start analysis.');
  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState<string>('No file selected');

  const verdictItems = useMemo(
    () => [
      { label: 'Loudness verdict', text: result?.loudnessVerdict, tone: 'info' as const },
      { label: 'Peak safety verdict', text: result?.peakSafetyVerdict, tone: 'info' as const },
      { label: 'Clipping warning', text: result?.clippingVerdict, tone: result?.clippingCount ? 'bad' : 'good' as BadgeTone },
      { label: 'Low/Mid/High verdict', text: result?.balanceVerdict, tone: 'info' as const },
      { label: 'Overall mastering suggestion', text: result?.masteringSuggestion, tone: toneForReadiness(result?.readiness) }
    ].filter((v) => Boolean(v.text)),
    [result]
  );

  async function onFileChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0] ?? null;
    if (!file) return;

    setLoading(true);
    setFileName(file.name);
    setStatus(`Analyzing ${file.name}...`);

    try {
      const analysis = await analyzeAudioFile(file);
      setResult(analysis);
      setStatus(`Analysis complete for ${file.name}.`);
    } catch {
      setResult(null);
      setStatus('We could not decode that file. Please try WAV, MP3, M4A, or OGG.');
    } finally {
      setLoading(false);
      event.target.value = '';
    }
  }

  return (
    <main className="app-shell">
      <section className="card compact">
        <header className="topbar">
          <div>
            <h1>Studio Sense</h1>
            <p className="subhead">Fast browser-based mastering check</p>
          </div>
          <label className="upload-btn" htmlFor="audio-upload">{loading ? 'Analyzing…' : 'Upload audio'}</label>
          <input id="audio-upload" type="file" accept="audio/*" onChange={onFileChange} disabled={loading} />
        </header>

        <section className="workflow-row">
          <span className="filename">File: {fileName}</span>
          <span className={`pill ${loading ? 'info' : 'good'}`}>{loading ? 'Processing' : 'Ready'}</span>
        </section>

        <p className="status">{status}</p>

        <section className="metrics-grid">
          <div className="metric"><span>Readiness</span><strong><span className={`pill ${toneForReadiness(result?.readiness)}`}>{result?.readiness ?? '—'}</span></strong></div>
          <div className="metric"><span>Score</span><strong>{formatScore(result?.score)}</strong></div>
          <div className="metric"><span>LUFS estimate</span><strong>{formatDb(result?.lufsEstimate)}</strong></div>
          <div className="metric"><span>Peak dBFS</span><strong>{formatDb(result?.peakDb)}</strong></div>
          <div className="metric"><span>RMS dB</span><strong>{formatDb(result?.rmsDb)}</strong></div>
          <div className="metric"><span>Clipping count</span><strong>{formatNumber(result?.clippingCount, 0)}</strong></div>
          <div className="metric"><span>Duration (s)</span><strong>{formatNumber(result?.durationSec, 2)}</strong></div>
          <div className="metric"><span>Sample rate</span><strong>{formatNumber(result?.sampleRate, 0)}</strong></div>
          <div className="metric"><span>Channels</span><strong>{formatNumber(result?.channels, 0)}</strong></div>
          <div className="metric span-2"><span>Low / Mid / High balance (rough)</span><strong>{formatNumber(result?.lowPercent, 0)} / {formatNumber(result?.midPercent, 0)} / {formatNumber(result?.highPercent, 0)}%</strong></div>
        </section>

        <section className="guidance">
          <h2>Target guidance</h2>
          <p>Target LUFS: {TARGET_LUFS}. Safe peak target: below {SAFE_PEAK_DBFS} dBFS.</p>
          <p>Browser-based estimate, not a replacement for studio metering.</p>
        </section>

        <section className="verdicts">
          <h2>Professional verdicts</h2>
          {verdictItems.length > 0 ? (
            <ul>
              {verdictItems.map((item) => (
                <li key={item.label}>
                  <span className={`pill ${item.tone}`}>{item.label}</span>
                  <span>{item.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">Upload a track to see verdicts.</p>
          )}
        </section>
      </section>
    </main>
  );
}
