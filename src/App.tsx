import { ChangeEvent, useMemo, useState } from 'react';

type AnalysisResult = {
  peakDb: number;
  rmsDb: number;
  clippingCount: number;
  artifactSpikes: number;
  durationSec: number;
  sampleRate: number;
  lowPct: number;
  midPct: number;
  highPct: number;
  verdicts: string[];
};

const toDb = (v: number): number => {
  if (v <= 1e-12) {
    return -120;
  }
  return 20 * Math.log10(v);
};

const clampPct = (value: number): number => Math.max(0, Math.min(100, value));

async function analyzeAudio(file: File): Promise<AnalysisResult> {
  const audioContext = new AudioContext();
  const arrayBuffer = await file.arrayBuffer();

  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    const { numberOfChannels, length, sampleRate, duration } = audioBuffer;

    let peak = 0;
    let sumSquares = 0;
    let clippingCount = 0;

    for (let channel = 0; channel < numberOfChannels; channel += 1) {
      const data = audioBuffer.getChannelData(channel);
      for (let i = 0; i < data.length; i += 1) {
        const sample = data[i];
        const abs = Math.abs(sample);
        if (abs > peak) peak = abs;
        sumSquares += sample * sample;
        if (abs >= 0.999) clippingCount += 1;
      }
    }

    const totalSamples = length * numberOfChannels;
    const rms = Math.sqrt(sumSquares / Math.max(1, totalSamples));

    // Mono mixdown for artifact and frequency analysis.
    const mono = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      let sum = 0;
      for (let channel = 0; channel < numberOfChannels; channel += 1) {
        sum += audioBuffer.getChannelData(channel)[i];
      }
      mono[i] = sum / numberOfChannels;
    }

    // Artifact spikes: count large sample-to-sample jumps.
    let artifactSpikes = 0;
    for (let i = 1; i < mono.length; i += 1) {
      if (Math.abs(mono[i] - mono[i - 1]) > 0.8) {
        artifactSpikes += 1;
      }
    }

    // Frequency balance from a lightweight DFT on a mono snapshot.
    const fftSize = Math.min(4096, mono.length);
    const frame = mono.slice(0, fftSize);
    const half = Math.floor(fftSize / 2);

    let lowEnergy = 0;
    let midEnergy = 0;
    let highEnergy = 0;

    for (let bin = 1; bin < half; bin += 1) {
      let real = 0;
      let imag = 0;
      for (let n = 0; n < fftSize; n += 1) {
        const phase = (2 * Math.PI * bin * n) / fftSize;
        real += frame[n] * Math.cos(phase);
        imag -= frame[n] * Math.sin(phase);
      }

      const magnitude = (real * real + imag * imag) / fftSize;
      const hz = (bin * sampleRate) / fftSize;

      if (hz < 250) lowEnergy += magnitude;
      else if (hz < 4000) midEnergy += magnitude;
      else highEnergy += magnitude;
    }

    const totalEnergy = lowEnergy + midEnergy + highEnergy;
    const lowPct = totalEnergy > 0 ? clampPct((lowEnergy / totalEnergy) * 100) : 0;
    const midPct = totalEnergy > 0 ? clampPct((midEnergy / totalEnergy) * 100) : 0;
    const highPct = totalEnergy > 0 ? clampPct((highEnergy / totalEnergy) * 100) : 0;

    const peakDb = toDb(peak);
    const rmsDb = toDb(rms);

    const verdicts: string[] = [];
    if (peakDb > -0.5 || rmsDb > -9) verdicts.push('Track too hot');
    if (peakDb < -8 || rmsDb < -19) verdicts.push('Track too quiet');
    if (clippingCount > 0) verdicts.push('Clipping');
    if (artifactSpikes > Math.max(300, duration * 20)) verdicts.push('Possible crackles/artifacts');
    if (highPct < 12) verdicts.push('Weak high-end clarity');
    if (lowPct > 38) verdicts.push('Too much low-end');
    if (verdicts.length === 0) verdicts.push('Balanced mix');

    return {
      peakDb,
      rmsDb,
      clippingCount,
      artifactSpikes,
      durationSec: duration,
      sampleRate,
      lowPct,
      midPct,
      highPct,
      verdicts,
    };
  } finally {
    await audioContext.close();
  }
}

function App() {
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const onFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setResult(null);
    setError('');
    setLoading(true);

    try {
      const analysis = await analyzeAudio(file);
      setResult(analysis);
    } catch {
      setError('Could not analyze this file. Please upload a valid audio file.');
    } finally {
      setLoading(false);
    }
  };

  const frequencyLabel = useMemo(() => {
    if (!result) return '';
    return `Low ${result.lowPct.toFixed(1)}% / Mid ${result.midPct.toFixed(1)}% / High ${result.highPct.toFixed(1)}%`;
  }, [result]);

  return (
    <main style={{ maxWidth: 720, margin: '2rem auto', fontFamily: 'sans-serif', lineHeight: 1.5 }}>
      <h1>Studio Sense</h1>
      <p>Upload a track and get quick engineer-style feedback.</p>
      <input type="file" accept="audio/*" onChange={onFileChange} />

      {loading && <p>Analyzing {fileName}...</p>}
      {error && <p style={{ color: 'crimson' }}>{error}</p>}

      {result && (
        <section>
          <h2>Analysis</h2>
          <ul>
            <li>Peak level: {result.peakDb.toFixed(2)} dBFS</li>
            <li>RMS loudness: {result.rmsDb.toFixed(2)} dBFS</li>
            <li>Clipping samples: {result.clippingCount}</li>
            <li>Artifact spikes: {result.artifactSpikes}</li>
            <li>Duration: {result.durationSec.toFixed(2)} sec</li>
            <li>Sample rate: {result.sampleRate} Hz</li>
            <li>Frequency balance: {frequencyLabel}</li>
          </ul>

          <h3>Verdict</h3>
          <ul>
            {result.verdicts.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

export default App;
