import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import AudioPlayer from './AudioPlayer';

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

type ProblemArea = {
  id: string;
  startSec: number;
  endSec: number;
  note: string;
  metrics: AnalysisResult;
};
type ProblemMarker = {
  id: string;
  timeSec: number;
  label: string;
  explanation: string;
  color: 'red' | 'yellow' | 'blue' | 'purple';
  estimated: boolean;
  kind: 'estimated' | 'user';
  endSec?: number;
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
function formatClock(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
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

function analyzeRange(audioBuffer: AudioBuffer, startSec = 0, endSec = audioBuffer.duration): AnalysisResult {
  const { sampleRate, numberOfChannels, length, duration } = audioBuffer;
  const start = clamp(Math.floor(startSec * sampleRate), 0, Math.max(length - 1, 0));
  const end = clamp(Math.floor(endSec * sampleRate), start + 1, length);
  const sectionLen = Math.max(end - start, 1);
  let peak = 0; let rmsAccumulator = 0; let sampleCount = 0; let clippingCount = 0;
  const mono = new Float32Array(sectionLen);

  for (let channel = 0; channel < numberOfChannels; channel += 1) {
    const data = audioBuffer.getChannelData(channel);
    for (let i = 0; i < sectionLen; i += 1) {
      const sample = data[start + i] ?? 0;
      const absSample = Math.abs(sample);
      if (absSample > peak) peak = absSample;
      if (absSample >= 0.999) clippingCount += 1;
      rmsAccumulator += sample * sample;
      mono[i] = (mono[i] ?? 0) + sample / numberOfChannels;
    }
    sampleCount += sectionLen;
  }

  const rms = Math.sqrt(rmsAccumulator / Math.max(sampleCount, 1));
  const peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;

  const fftSize = Math.min(32768, 2 ** Math.floor(Math.log2(Math.max(1024, mono.length))));
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
  if (loudnessDelta > 1) loudnessVerdict = `Too loud by about ${loudnessDelta.toFixed(1)} dB. Reduce gain/limiter output.`;
  if (loudnessDelta < -1) loudnessVerdict = `Too quiet by about ${Math.abs(loudnessDelta).toFixed(1)} dB. Add gain/limiting.`;
  const peakSafetyVerdict = peakDb < SAFE_PEAK_DBFS ? `Safe peak headroom (${formatDb(peakDb)} below -1 dBFS target).` : `Peak is above safe target by ${(peakDb - SAFE_PEAK_DBFS).toFixed(1)} dB. Lower ceiling.`;
  const clippingVerdict = clippingCount > 0 ? `Clipping risk detected (${clippingCount} clipped samples).` : 'No clipping detected in sample data.';
  const balanceVerdict = getBalanceVerdict(lowPercent, midPercent, highPercent);
  let readiness: ReadinessCategory = 'Release Ready';
  if (clippingCount > 0 || peakDb >= -0.2 || Math.abs(loudnessDelta) > 4) readiness = 'Problem Area';
  else if (Math.abs(loudnessDelta) > 1.5 || peakDb > SAFE_PEAK_DBFS || lowPercent > 44 || highPercent < 10) readiness = 'Needs Work';
  let masteringSuggestion = 'Minor polish only. Keep headroom and compare against references.';
  if (readiness === 'Needs Work') masteringSuggestion = 'Adjust gain staging and EQ balance, then re-check loudness and peaks.';
  if (readiness === 'Problem Area') masteringSuggestion = 'Reduce limiting, fix clipping/ceiling, and rebalance tone before release.';

  return { durationSec: endSec - startSec || duration, sampleRate, channels: numberOfChannels, peakDb, rmsDb, clippingCount, lowPercent, midPercent, highPercent, lufsEstimate, score, loudnessVerdict, peakSafetyVerdict, clippingVerdict, balanceVerdict, masteringSuggestion, readiness };
}

function toneForReadiness(value?: ReadinessCategory): BadgeTone { if (value === 'Release Ready') return 'good'; if (value === 'Needs Work') return 'warn'; if (value === 'Problem Area') return 'bad'; return 'info'; }

export default function App() {
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [startSec, setStartSec] = useState<number | null>(null);
  const [endSec, setEndSec] = useState<number | null>(null);
  const [sectionResult, setSectionResult] = useState<AnalysisResult | null>(null);
  const [problemNote, setProblemNote] = useState('');
  const [problemAreas, setProblemAreas] = useState<ProblemArea[]>([]);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [status, setStatus] = useState('Upload audio to start analysis.');
  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState('No file selected');
  const [seekToSec, setSeekToSec] = useState<number | null>(null);

  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);

  const hasSelection = startSec !== null && endSec !== null && endSec > startSec;
  const verdictItems = useMemo(() => [
    { label: 'Loudness verdict', text: result?.loudnessVerdict, tone: 'info' as const },
    { label: 'Peak safety verdict', text: result?.peakSafetyVerdict, tone: 'info' as const },
    { label: 'Clipping warning', text: result?.clippingVerdict, tone: result?.clippingCount ? 'bad' : 'good' as BadgeTone },
    { label: 'Low/Mid/High verdict', text: result?.balanceVerdict, tone: 'info' as const },
    { label: 'Overall mastering suggestion', text: result?.masteringSuggestion, tone: toneForReadiness(result?.readiness) }
  ].filter((v) => Boolean(v.text)), [result]);

  async function onFileChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0] ?? null; if (!file) return;
    setLoading(true); setFileName(file.name); setStatus(`Analyzing ${file.name}...`);
    setSectionResult(null); setStartSec(null); setEndSec(null); setProblemAreas([]); setProblemNote('');
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    const url = URL.createObjectURL(file); setAudioUrl(url);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const audioContext = new AudioContext();
      const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
      await audioContext.close();
      setAudioBuffer(decoded);
      const analysis = analyzeRange(decoded, 0, decoded.duration);
      setResult(analysis); setDuration(decoded.duration); setCurrentTime(0);
      setStatus(`Analysis complete for ${file.name}.`);
    } catch {
      setResult(null); setAudioBuffer(null); setStatus('We could not decode that file. Please try WAV, MP3, M4A, or OGG.');
    } finally { setLoading(false); event.target.value = ''; }
  }

  const sectionNarrative = sectionResult && result ? [
    `Problem area detected from ${formatClock(startSec)} to ${formatClock(endSec)}.`,
    sectionResult.lufsEstimate && result.lufsEstimate && sectionResult.lufsEstimate > result.lufsEstimate ? 'This section is louder than the whole track.' : 'This section is not louder than the whole track.',
    sectionResult.lowPercent && result.lowPercent && sectionResult.lowPercent > result.lowPercent ? 'This section has more low-end build-up.' : 'Low-end is not more built-up than full track.',
    sectionResult.highPercent && result.highPercent && sectionResult.highPercent < result.highPercent ? 'This section has reduced clarity / high-end energy.' : 'High-end clarity is similar or higher than full track.'
  ] : [];
  const estimatedMarkers = useMemo<ProblemMarker[]>(() => {
    if (!result) return [];
    const trackDuration = result.durationSec ?? duration;
    if (!trackDuration || trackDuration <= 0) return [];
    const markers: ProblemMarker[] = [];
    const toneUnusual = (result.lowPercent ?? 30) > 44 || (result.lowPercent ?? 30) < 22 || (result.highPercent ?? 18) > 28 || (result.highPercent ?? 18) < 12 || (result.midPercent ?? 45) < 36;
    if ((result.peakDb ?? -Infinity) > -1) markers.push({ id: 'peak-risk', timeSec: trackDuration * 0.25, label: 'Peak risk', explanation: 'Estimated marker based on whole-track analysis. Use your ears to confirm this section.', color: 'red', estimated: true, kind: 'estimated' });
    if ((result.lufsEstimate ?? TARGET_LUFS) < -16) markers.push({ id: 'too-quiet', timeSec: trackDuration * 0.5, label: 'Too quiet', explanation: 'Estimated marker based on whole-track analysis. Use your ears to confirm this section.', color: 'yellow', estimated: true, kind: 'estimated' });
    if (toneUnusual) markers.push({ id: 'tone-balance', timeSec: trackDuration * 0.75, label: 'Tone balance', explanation: 'Estimated marker based on whole-track analysis. Use your ears to confirm this section.', color: 'blue', estimated: true, kind: 'estimated' });
    if ((result.clippingCount ?? 0) > 0) markers.push({ id: 'clipping', timeSec: trackDuration * 0.9, label: 'Clipping', explanation: 'Estimated marker based on whole-track analysis. Use your ears to confirm this section.', color: 'red', estimated: true, kind: 'estimated' });
    return markers;
  }, [duration, result]);
  const userMarkers = useMemo<ProblemMarker[]>(() => problemAreas.map((p) => ({
    id: `user-${p.id}`,
    timeSec: p.startSec,
    endSec: p.endSec,
    label: 'User problem marker',
    explanation: p.note || 'User-marked section.',
    color: 'purple',
    estimated: false,
    kind: 'user'
  })), [problemAreas]);
  const allMarkers = useMemo(() => [...estimatedMarkers, ...userMarkers], [estimatedMarkers, userMarkers]);

  return <main className="app-shell"><section className="card compact"><header className="topbar"><div><div className="brand-row"><span className="brand-icon" aria-hidden="true"><svg viewBox="0 0 64 64" role="img"><path d="M12 38V31C12 19.4 21.4 10 33 10s21 9.4 21 21v7" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round"/><rect x="9" y="33" width="11" height="20" rx="5" fill="currentColor"/><rect x="46" y="33" width="11" height="20" rx="5" fill="currentColor"/></svg></span><h1>Studio Sense</h1></div><p className="subhead">Interactive listening + section mastering check</p></div><label className="upload-btn" htmlFor="audio-upload">{loading ? 'Analyzing…' : 'Upload audio'}</label><input id="audio-upload" type="file" accept="audio/*" onChange={onFileChange} disabled={loading} /></header>
  <section className="workflow-row"><span className="filename">File: {fileName}</span><span className={`pill ${loading ? 'info' : 'good'}`}>{loading ? 'Processing' : 'Ready'}</span></section><p className="status">{status}</p>

  {audioUrl && <AudioPlayer
    audioUrl={audioUrl}
    startSec={startSec}
    endSec={endSec}
    timelineMarkers={allMarkers}
    seekToSec={seekToSec}
    onSeekHandled={() => setSeekToSec(null)}
    onTimeChange={setCurrentTime}
    onDurationChange={setDuration}
  />} 

  <section className="guidance"><h2>Section selection</h2><div className="workflow-row"><button className="upload-btn" type="button" onClick={() => setStartSec(currentTime)} disabled={!audioBuffer}>Mark start</button><button className="upload-btn" type="button" onClick={() => setEndSec(currentTime)} disabled={!audioBuffer}>Mark end</button><button className="upload-btn" type="button" onClick={() => { setStartSec(null); setEndSec(null); setSectionResult(null); }} disabled={!audioBuffer}>Clear section</button></div>
    <div className="metrics-grid"><div className="metric"><span>Start</span><strong>{formatClock(startSec)}</strong></div><div className="metric"><span>End</span><strong>{formatClock(endSec)}</strong></div><div className="metric"><span>Length</span><strong>{hasSelection ? formatClock((endSec ?? 0) - (startSec ?? 0)) : '00:00'}</strong></div><div className="metric"><span>Manual (sec)</span><strong><input className="time-input" type="number" min={0} max={duration} value={startSec ?? 0} onChange={(e) => setStartSec(Number(e.target.value))} /> <input className="time-input" type="number" min={0} max={duration} value={endSec ?? 0} onChange={(e) => setEndSec(Number(e.target.value))} /></strong></div></div>
    <div className="workflow-row"><button className="upload-btn" type="button" disabled={!audioBuffer || !hasSelection} onClick={() => { if (!audioBuffer || !hasSelection) return; setSectionResult(analyzeRange(audioBuffer, startSec ?? 0, endSec ?? 0)); }}>Analyze selected section</button></div>
  </section>

  <section className="metrics-grid">
    <div className="metric"><span>Readiness</span><strong><span className={`pill ${toneForReadiness(result?.readiness)}`}>{result?.readiness ?? '—'}</span></strong></div><div className="metric"><span>Score</span><strong>{formatScore(result?.score)}</strong></div><div className="metric"><span>LUFS estimate</span><strong>{formatDb(result?.lufsEstimate)}</strong></div><div className="metric"><span>Peak dBFS</span><strong>{formatDb(result?.peakDb)}</strong></div><div className="metric"><span>RMS dB</span><strong>{formatDb(result?.rmsDb)}</strong></div><div className="metric"><span>Clipping count</span><strong>{formatNumber(result?.clippingCount, 0)}</strong></div><div className="metric"><span>Duration (s)</span><strong>{formatNumber(result?.durationSec, 2)}</strong></div><div className="metric"><span>Sample rate</span><strong>{formatNumber(result?.sampleRate, 0)}</strong></div><div className="metric"><span>Channels</span><strong>{formatNumber(result?.channels, 0)}</strong></div><div className="metric span-2"><span>Low / Mid / High balance (rough)</span><strong>{formatNumber(result?.lowPercent, 0)} / {formatNumber(result?.midPercent, 0)} / {formatNumber(result?.highPercent, 0)}%</strong></div>
  </section>

  <section className="guidance"><h2>Selected Section Analysis</h2><p className="empty">Browser-based estimate only.</p>{sectionResult ? <><section className="metrics-grid"><div className="metric"><span>Readiness</span><strong><span className={`pill ${toneForReadiness(sectionResult.readiness)}`}>{sectionResult.readiness ?? '—'}</span></strong></div><div className="metric"><span>Score</span><strong>{formatScore(sectionResult.score)}</strong></div><div className="metric"><span>LUFS estimate</span><strong>{formatDb(sectionResult.lufsEstimate)}</strong></div><div className="metric"><span>Peak dBFS</span><strong>{formatDb(sectionResult.peakDb)}</strong></div><div className="metric"><span>RMS dB</span><strong>{formatDb(sectionResult.rmsDb)}</strong></div><div className="metric"><span>Clipping count</span><strong>{formatNumber(sectionResult.clippingCount, 0)}</strong></div><div className="metric span-2"><span>Low / Mid / High rough balance</span><strong>{formatNumber(sectionResult.lowPercent, 0)} / {formatNumber(sectionResult.midPercent, 0)} / {formatNumber(sectionResult.highPercent, 0)}%</strong></div></section>{sectionNarrative.map((n) => <p key={n}>{n}</p>)}<div className="verdicts section-verdicts"><ul>{[{ label: 'Loudness verdict', text: sectionResult.loudnessVerdict }, { label: 'Peak safety verdict', text: sectionResult.peakSafetyVerdict }, { label: 'Clipping warning', text: sectionResult.clippingVerdict }, { label: 'Low/Mid/High verdict', text: sectionResult.balanceVerdict }, { label: 'Mastering suggestion', text: sectionResult.masteringSuggestion }].filter((item) => Boolean(item.text)).map((item) => <li key={item.label}><span className="pill info">{item.label}</span><span>{item.text}</span></li>)}</ul></div><div className="workflow-row"><input className="note-input" value={problemNote} placeholder="Short problem note" onChange={(e) => setProblemNote(e.target.value)} /><button className="upload-btn" type="button" onClick={() => { if (!hasSelection || !sectionResult) return; setProblemAreas((prev) => [{ id: `${Date.now()}`, startSec: startSec ?? 0, endSec: endSec ?? 0, note: problemNote || 'Marked problem area', metrics: sectionResult }, ...prev]); setProblemNote(''); }}>Mark as problem area</button></div></> : <p className="empty">Select a valid start/end range, then analyze selected section.</p>}</section>

  <section className="verdicts"><h2>Whole Track Analysis</h2>{verdictItems.length > 0 ? <ul>{verdictItems.map((item) => <li key={item.label}><span className={`pill ${item.tone}`}>{item.label}</span><span>{item.text}</span></li>)}</ul> : <p className="empty">Upload a track to see verdicts.</p>}</section>

  <section className="verdicts"><h2>Marked Problem Areas</h2>{problemAreas.length ? <ul>{problemAreas.map((p) => <li key={p.id}><span className="pill bad">Problem area: {formatClock(p.startSec)}–{formatClock(p.endSec)}</span><span>{p.note}. Score {formatScore(p.metrics.score)}. Key verdict: {p.metrics.masteringSuggestion ?? p.metrics.clippingVerdict ?? 'Review section metrics.'}</span></li>)}</ul> : <p className="empty">No marked areas yet.</p>}</section>
  <section className="verdicts"><h2>Estimated Problem Markers</h2>{allMarkers.length ? <ul>{allMarkers.map((m) => <li key={m.id}><span className={`pill ${m.color === 'red' ? 'bad' : m.color === 'yellow' ? 'warn' : m.color === 'blue' ? 'info' : 'info'}`}>{m.kind === 'user' ? `User marker: ${formatClock(m.timeSec)}-${formatClock(m.endSec)}` : `${m.label}: ${formatClock(m.timeSec)}`}</span><span>{m.explanation} {m.kind === 'estimated' ? '' : 'Use your ears to confirm this section.'} <button className="jump-btn" type="button" onClick={() => setSeekToSec(m.timeSec)}>Jump</button></span></li>)}</ul> : <p className="empty">No markers yet. Run whole-track analysis or mark a section as a problem area.</p>}</section>

  <section className="guidance"><h2>Target guidance</h2><p>Target LUFS: {TARGET_LUFS}. Safe peak target: below {SAFE_PEAK_DBFS} dBFS.</p><p>Browser-based estimate (including LUFS estimate), not a replacement for studio metering.</p></section>
</section></main>;
}
