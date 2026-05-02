import { useMemo, useState, type ChangeEvent } from 'react';

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
  verdicts?: string[] | null;
};

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

    let score = 100;
    score -= clamp(Math.abs((peakDb ?? -2) + 1), 0, 20) * 1.2;
    score -= clamp(Math.abs((rmsDb ?? -14) + 14), 0, 20) * 1.5;
    score -= clamp(clippingCount / 500, 0, 20);
    score -= clamp(Math.abs(midPercent - 55) / 2.5, 0, 20);
    score = clamp(score, 0, 100);

    const verdicts: string[] = [];
    if (clippingCount > 0) verdicts.push('Clipping detected; lower limiter/peak level.');
    else verdicts.push('No clipping detected.');

    if (lufsEstimate > -10) verdicts.push('Very loud master; may lose dynamics.');
    else if (lufsEstimate < -17) verdicts.push('Quiet master; consider increasing loudness.');
    else verdicts.push('Loudness is in a typical streaming range.');

    if (highPercent > 25) verdicts.push('High-frequency energy is bright.');
    if (lowPercent > 45) verdicts.push('Low-end is dominant.');
    if (midPercent < 40) verdicts.push('Midrange may feel recessed.');

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
      verdicts
    };
  } finally {
    await audioContext.close();
  }
}

export default function App() {
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [status, setStatus] = useState<string>('Choose an audio file to analyze.');
  const [loading, setLoading] = useState(false);

  const safeVerdicts = useMemo(() => {
    if (!result?.verdicts || !Array.isArray(result.verdicts)) return [];
    return result.verdicts.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  }, [result]);

  async function onFileChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0] ?? null;
    if (!file) return;

    setLoading(true);
    setStatus(`Analyzing ${file.name}...`);

    try {
      const analysis = await analyzeAudioFile(file);
      setResult(analysis);
      setStatus(`Done: ${file.name}`);
    } catch {
      setResult(null);
      setStatus('Could not analyze this file. Try WAV/MP3/M4A/OGG.');
    } finally {
      setLoading(false);
      event.target.value = '';
    }
  }

  return (
    <main className="app-shell">
      <section className="card compact">
        <header className="card-header">
          <h1>Studio Sense</h1>
          <label className="upload-btn" htmlFor="audio-upload">{loading ? 'Analyzing…' : 'Upload audio'}</label>
          <input id="audio-upload" type="file" accept="audio/*" onChange={onFileChange} disabled={loading} />
        </header>

        <p className="status">{status}</p>

        <div className="metrics-grid wide">
          <div className="metric"><span>Score</span><strong>{formatScore(result?.score)}</strong></div>
          <div className="metric"><span>Duration (s)</span><strong>{formatNumber(result?.durationSec, 2)}</strong></div>
          <div className="metric"><span>Sample rate</span><strong>{formatNumber(result?.sampleRate, 0)}</strong></div>
          <div className="metric"><span>Channels</span><strong>{formatNumber(result?.channels, 0)}</strong></div>
          <div className="metric"><span>Peak</span><strong>{formatDb(result?.peakDb)}</strong></div>
          <div className="metric"><span>RMS</span><strong>{formatDb(result?.rmsDb)}</strong></div>
          <div className="metric"><span>LUFS est.</span><strong>{formatDb(result?.lufsEstimate)}</strong></div>
          <div className="metric"><span>Clipping count</span><strong>{formatNumber(result?.clippingCount, 0)}</strong></div>
          <div className="metric"><span>Low / Mid / High</span><strong>{formatNumber(result?.lowPercent, 0)} / {formatNumber(result?.midPercent, 0)} / {formatNumber(result?.highPercent, 0)}%</strong></div>
        </div>

        <div className="verdicts">
          <h2>Verdicts</h2>
          {safeVerdicts.length > 0 ? (
            <ul>
              {safeVerdicts.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <p className="empty">No verdicts available.</p>
          )}
        </div>
      </section>
    </main>
  );
}
