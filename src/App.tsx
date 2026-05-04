import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import AudioPlayer from './AudioPlayer';
import ReleaseChecklist from './ReleaseChecklist';

type ReadinessCategory = 'Release Ready' | 'Needs Work' | 'Problem Area';
type BadgeTone = 'good' | 'warn' | 'bad' | 'info';

type AnalysisResult = {
  lufs?: number | null;
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
  severity: 'low' | 'medium' | 'high';
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


function buildProblemMarkers(result: AnalysisResult): ProblemMarker[] {
  const durationSec = result.durationSec ?? 0;
  if (!(durationSec > 0)) return [];

  const candidates = [
    { active: ((result.lufs ?? result.lufsEstimate) ?? 0) < -18, label: 'Too quiet → add gain', color: 'red' as const },
    { active: (result.rmsDb ?? 0) < -20, label: 'Weak signal → normalize', color: 'yellow' as const },
    { active: (result.channels ?? 0) === 1, label: 'Mono → add width', color: 'red' as const },
    { active: (result.lowPercent ?? 100) < 20, label: 'Thin sound → boost bass', color: 'yellow' as const }
  ];
  const slots = [0.1, 0.3, 0.5, 0.7];

  return candidates
    .filter((c) => c.active)
    .map((candidate, index) => ({
      id: `auto-${index}-${candidate.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      timeSec: durationSec * slots[index],
      label: candidate.label,
      severity: 'high' as const,
      explanation: 'Auto-generated from whole-track analysis.',
      color: candidate.color,
      estimated: true,
      kind: 'estimated' as const
    }));
}


function getSoundProfile(data: AnalysisResult | null): string {
  if (!data) return '—';

  const phrases: string[] = [];
  const lufs = data.lufs ?? data.lufsEstimate;

  if (typeof data.rmsDb === 'number' && data.rmsDb < -20) phrases.push('weak');
  if (typeof lufs === 'number' && lufs < -20) phrases.push('quiet');
  if ((data.channels ?? 0) === 1) phrases.push('mono');
  if (typeof data.lowPercent === 'number' && data.lowPercent < 15) phrases.push('thin');
  if (typeof data.lowPercent === 'number' && data.lowPercent > 60) phrases.push('boomy');
  if (!phrases.length) return 'Clean and balanced recording';

  const unique = [...new Set(phrases)];
  if (unique.length === 1) return `${unique[0]} recording`;
  if (unique.length === 2) return `${unique[0]} recording with ${unique[1]} sound`;
  const descriptor = unique.slice(0, -1).join(', ');
  return `${descriptor} recording with ${unique[unique.length - 1]} sound`;
}

function getWhy(data: AnalysisResult | null): string[] {
  if (!data) return ['Run analysis to explain why the current sound character appears.'];
  const reasons: string[] = [];
  const lufs = data.lufs ?? data.lufsEstimate;
  if (typeof lufs === 'number' && lufs < -20) reasons.push('Low volume makes the audio sound distant.');
  if (typeof data.rmsDb === 'number' && data.rmsDb < -20) reasons.push('Weak signal reduces presence and clarity.');
  if ((data.channels ?? 0) === 1) reasons.push('Mono removes stereo width and depth.');
  if (typeof data.lowPercent === 'number' && data.lowPercent < 15) reasons.push('Lack of low frequencies makes it sound thin.');
  if (typeof data.lowPercent === 'number' && data.lowPercent > 60) reasons.push('Too much low-end energy makes the mix boomy.');
  if (!reasons.length) return ['Loudness, tone balance, and stereo depth are in healthy ranges.'];
  return reasons.slice(0, 3);
}

function getFixes(data: AnalysisResult | null): string[] {
  if (!data) return [];
  const fixes: string[] = [];
  const lufs = data.lufs ?? data.lufsEstimate;
  if (typeof lufs === 'number' && lufs < -20) fixes.push('Increase gain (+6 to +10 dB)');
  if (typeof data.rmsDb === 'number' && data.rmsDb < -20) fixes.push('Normalize audio or re-record with stronger input');
  if ((data.channels ?? 0) === 1) fixes.push('Convert to stereo or add stereo widening');
  if (typeof data.lowPercent === 'number' && data.lowPercent < 15) fixes.push('Boost low frequencies (80–150 Hz)');
  if (typeof data.lowPercent === 'number' && data.lowPercent > 60) fixes.push('Reduce low frequencies (80–200 Hz)');
  if ((data.clippingCount ?? 0) > 0) fixes.push('Lower limiter ceiling to -1 dB');
  return fixes;
}

function getAudioType(data: AnalysisResult | null): string {
  if (!data) return '—';
  const channels = data.channels ?? 0;
  const rms = data.rmsDb ?? -99;
  if (channels === 1 && rms < -20) return 'Likely old recording, phone capture, or tape source';
  if (channels === 2 && rms > -18) return 'Modern digital recording';
  return 'Standard recording quality';
}

function toneForReadiness(value?: ReadinessCategory): BadgeTone { if (value === 'Release Ready') return 'good'; if (value === 'Needs Work') return 'warn'; if (value === 'Problem Area') return 'bad'; return 'info'; }

function buildPlainEnglishSummary(result: AnalysisResult): { hearing: string[]; why: string[]; next: string[]; healthy: boolean } {
  const hearing: string[] = [];
  const why: string[] = [];
  const next: string[] = [];

  const lufs = result.lufs ?? result.lufsEstimate;
  const rms = result.rmsDb;
  const channels = result.channels ?? 0;
  const low = result.lowPercent;
  const peak = result.peakDb;
  const clippingCount = result.clippingCount ?? 0;
  const isMono = channels === 1;

  if (typeof lufs === 'number' && lufs < -16) {
    hearing.push('The track sounds quiet compared with most modern releases.');
    why.push('Overall loudness is lower than common streaming targets.');
    next.push('Increase loudness using gain staging and a limiter, then compare against a reference track.');
  }
  if (typeof rms === 'number' && rms < -20) {
    hearing.push('It feels soft and low-energy in parts.');
    why.push('Signal strength is weak, so the mix loses punch and presence.');
    next.push('Use gentle compression, gain, or a cleaner source recording to improve energy.');
  }
  if (isMono) {
    hearing.push('It sounds narrow, like most elements are in the center.');
    why.push('The file appears to be mono or has very limited stereo width.');
    next.push('Check the export settings for stereo and add subtle width only if it fits the song.');
  }
  if (typeof low === 'number' && low < 22) {
    hearing.push('The low-end feels thin and lacks warmth.');
    why.push('Low frequencies are under-represented compared with mids and highs.');
    next.push('Add low-end EQ around 80–200 Hz and re-check on speakers and headphones.');
  }
  if (typeof low === 'number' && low > 44) {
    hearing.push('The bass feels heavy and can get boomy.');
    why.push('Too much spectral energy is concentrated in the low frequencies.');
    next.push('Reduce muddy low frequencies with subtractive EQ and tighten the low-end dynamics.');
  }
  if (typeof peak === 'number' && peak > -1) {
    hearing.push('The loudest moments are very close to distortion.');
    why.push('Peak level is above the safer mastering headroom target.');
    next.push('Lower limiter ceiling/output to keep peaks below -1 dBFS.');
  }
  if (clippingCount > 0) {
    hearing.push('There may be audible crackle or harsh distortion on peaks.');
    why.push('Clipping was detected in the waveform.');
    next.push('Back off limiting or gain, then export again and verify clipping is gone.');
  }

  const healthy = hearing.length === 0;
  if (healthy) {
    hearing.push('The track already sounds balanced and competitive for release.');
    why.push('Loudness, peak headroom, stereo format, and tonal balance are within healthy ranges.');
    next.push('Do a final reference check, then export your release master.');
  }

  return { hearing, why, next, healthy };
}


export default function App() {
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [startSec, setStartSec] = useState<number | null>(null);
  const [endSec, setEndSec] = useState<number | null>(null);
  const [sectionResult, setSectionResult] = useState<AnalysisResult | null>(null);
  const [problemNote, setProblemNote] = useState('');
  const [manualProblemAreas, setManualProblemAreas] = useState<ProblemArea[]>([]);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [autoMarkers, setAutoMarkers] = useState<ProblemMarker[]>([]);
  const [status, setStatus] = useState('Upload audio to start analysis.');
  const [analysisStatus, setAnalysisStatus] = useState<'idle' | 'processing' | 'complete' | 'failed'>('idle');
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
    setLoading(true); setFileName(file.name); setStatus('Audio ready for playback'); setAnalysisStatus('processing');
    setSectionResult(null); setStartSec(null); setEndSec(null); setManualProblemAreas([]); setProblemNote(''); setResult(null); setAutoMarkers([]);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    const url = URL.createObjectURL(file); setAudioUrl(url);
    setAudioBuffer(null);
    setCurrentTime(0);
    setDuration(0);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const audioContext = new AudioContext();
      const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
      await audioContext.close();
      setAudioBuffer(decoded);
      const analysis = analyzeRange(decoded, 0, decoded.duration);
      setResult(analysis);
      const markers = buildProblemMarkers(analysis);
      setAutoMarkers(markers);
      setDuration(decoded.duration); setCurrentTime(0);
      setStatus('Analysis complete');
      setAnalysisStatus('complete');
    } catch {
      setResult(null); setAudioBuffer(null); setStatus('Audio ready for playback');
      setAnalysisStatus('failed');
    } finally { setLoading(false); event.target.value = ''; }
  }

  const sectionNarrative = sectionResult && result ? [
    `Problem area detected from ${formatClock(startSec)} to ${formatClock(endSec)}.`,
    sectionResult.lufsEstimate && result.lufsEstimate && sectionResult.lufsEstimate > result.lufsEstimate ? 'This section is louder than the whole track.' : 'This section is not louder than the whole track.',
    sectionResult.lowPercent && result.lowPercent && sectionResult.lowPercent > result.lowPercent ? 'This section has more low-end build-up.' : 'Low-end is not more built-up than full track.',
    sectionResult.highPercent && result.highPercent && sectionResult.highPercent < result.highPercent ? 'This section has reduced clarity / high-end energy.' : 'High-end clarity is similar or higher than full track.'
  ] : [];
  const hasAnalyzedTrack = Boolean(result);
  const plainEnglishSummary = result ? buildPlainEnglishSummary(result) : null;
  const soundProfile = getSoundProfile(result);
  const whyItSoundsThisWay = getWhy(result);
  const fixSuggestions = getFixes(result);
  const audioType = getAudioType(result);
  const markerGuidance: Record<string, { title: string; explanation: string; fix: string; badgeTone: 'bad' | 'warn' }> = {
    'Too quiet → add gain': {
      title: 'Volume too low',
      explanation: 'This part may sound too quiet compared with other songs.',
      fix: 'Increase gain +8 dB',
      badgeTone: 'bad'
    },
    'Weak signal → normalize': {
      title: 'Weak recording quality',
      explanation: 'This section lacks strength and presence.',
      fix: 'Normalize audio',
      badgeTone: 'warn'
    },
    'Mono → add width': {
      title: 'Flat / mono sound',
      explanation: 'The sound feels narrow and has little stereo space.',
      fix: 'Add stereo width',
      badgeTone: 'warn'
    },
    'Thin sound → boost bass': {
      title: 'Lacks bass / thin sound',
      explanation: 'Bass and warmth are weak here.',
      fix: 'Boost low frequencies around 80–150 Hz.',
      badgeTone: 'warn'
    },
    'Custom problem area': {
      title: 'Marked section needs attention',
      explanation: 'You marked this section as a problem area while listening.',
      fix: 'Review this section and apply the note you added.',
      badgeTone: 'warn'
    }
  };

  const combinedProblemMarkers = useMemo(
    () => [
      ...autoMarkers,
      ...manualProblemAreas.map((p) => ({
        id: p.id,
        label: 'Custom problem area',
        timeSec: p.startSec,
        color: 'purple' as const,
        explanation: p.note || 'Marked from selected section.',
        estimated: false,
        kind: 'user' as const,
        endSec: p.endSec
      }))
    ],
    [autoMarkers, manualProblemAreas]
  );


  return <main className="app-shell"><section className="card compact"><header className="topbar"><div><div className="brand-row"><span className="brand-icon" aria-hidden="true"><svg viewBox="0 0 64 64" role="img"><path d="M12 38V31C12 19.4 21.4 10 33 10s21 9.4 21 21v7" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round"/><rect x="9" y="33" width="11" height="20" rx="5" fill="currentColor"/><rect x="46" y="33" width="11" height="20" rx="5" fill="currentColor"/></svg></span><h1>Studio Sense</h1></div><p className="subhead">Interactive listening + section mastering check</p></div><label className="upload-btn" htmlFor="audio-upload">{loading ? 'Analyzing…' : 'Upload audio'}</label><input id="audio-upload" type="file" accept="audio/*" onChange={onFileChange} /></header>
  <section className="workflow-row"><span className="filename">File: {fileName}</span><span className={`pill ${loading ? 'info' : 'good'}`}>{loading ? 'Processing' : 'Ready'}</span></section><p className="status">{status}</p><p className="status">{analysisStatus === 'processing' ? 'Analysis processing...' : analysisStatus === 'complete' ? 'Analysis complete' : analysisStatus === 'failed' ? 'Analysis failed (playback may still work).' : 'Upload audio to begin analysis.'}</p>

  {audioUrl && <AudioPlayer
    audioUrl={audioUrl}
    startSec={startSec}
    endSec={endSec}
    timelineMarkers={autoMarkers}
    seekToSec={seekToSec}
    onSeekHandled={() => setSeekToSec(null)}
    onTimeChange={setCurrentTime}
    onDurationChange={setDuration}
  />} 


  <section className="sound-profile-card"><h2>🎧 Sound Profile</h2><p>{soundProfile}</p></section>
  <section className="sound-profile-card"><h2>📼 Audio Type</h2><p>{audioType}</p></section>
  <section className="guidance"><h2>🧠 Why it sounds like this</h2><ul>{whyItSoundsThisWay.map((reason) => <li key={reason}>{reason}</li>)}</ul></section>
  <section className="guidance"><h2>🛠 How to fix it</h2>{fixSuggestions.length ? <ul>{fixSuggestions.map((fix) => <li key={fix}>{fix}</li>)}</ul> : <p>Looks healthy. Use minor polish and final reference checks.</p>}</section>

  <section className="verdicts"><h2>Whole Track Analysis</h2>{verdictItems.length > 0 ? <ul>{verdictItems.map((item) => <li key={item.label}><span className={`pill ${item.tone}`}>{item.label}</span><span>{item.text}</span></li>)}</ul> : <p className="empty">Upload a track to see verdicts.</p>}</section>

  <section className="verdicts problem-timeline"><h2>Markers (enhanced)</h2>{hasAnalyzedTrack ? <>{combinedProblemMarkers.length ? <><ul>{combinedProblemMarkers.map((m) => { const guidance = markerGuidance[m.label] ?? { title: m.label, explanation: m.explanation, fix: 'Review this section and compare against a reference track.', badgeTone: 'warn' as const }; return <li key={m.id} className="timeline-item"><div className="timeline-title-row"><span className={`pill ${guidance.badgeTone}`}>{guidance.title}</span><strong>{formatClock(m.timeSec)}</strong></div><span>{`${m.label} → ${guidance.fix}`}</span><span>{guidance.explanation}</span><button className="jump-btn" type="button" onClick={() => setSeekToSec(m.timeSec)}>Jump</button></li>; })}</ul></> : <p className="empty">✅ No major problem sections detected. Your track is close to release-ready.</p>}</> : <p className="empty">Upload a track to generate problem markers.</p>}</section>

  <section className="guidance"><h2>Section selection</h2><div className="workflow-row"><button className="upload-btn" type="button" onClick={() => setStartSec(currentTime)} disabled={!audioBuffer}>Mark start</button><button className="upload-btn" type="button" onClick={() => setEndSec(currentTime)} disabled={!audioBuffer}>Mark end</button><button className="upload-btn" type="button" onClick={() => { setStartSec(null); setEndSec(null); setSectionResult(null); }} disabled={!audioBuffer}>Clear section</button></div>
    <div className="metrics-grid"><div className="metric"><span>Start</span><strong>{formatClock(startSec)}</strong></div><div className="metric"><span>End</span><strong>{formatClock(endSec)}</strong></div><div className="metric"><span>Length</span><strong>{hasSelection ? formatClock((endSec ?? 0) - (startSec ?? 0)) : '00:00'}</strong></div><div className="metric"><span>Manual (sec)</span><strong><input className="time-input" type="number" min={0} max={duration} value={startSec ?? 0} onChange={(e) => setStartSec(Number(e.target.value))} /> <input className="time-input" type="number" min={0} max={duration} value={endSec ?? 0} onChange={(e) => setEndSec(Number(e.target.value))} /></strong></div></div>
    <div className="workflow-row"><button className="upload-btn" type="button" disabled={!audioBuffer || !hasSelection} onClick={() => { if (!audioBuffer || !hasSelection) return; setSectionResult(analyzeRange(audioBuffer, startSec ?? 0, endSec ?? 0)); }}>Analyze selected section</button></div>
  </section>

  <section className="metrics-grid">
    <div className="metric"><span>Readiness</span><strong><span className={`pill ${toneForReadiness(result?.readiness)}`}>{result?.readiness ?? '—'}</span></strong></div><div className="metric"><span>Score</span><strong>{formatScore(result?.score)}</strong></div><div className="metric"><span>LUFS estimate</span><strong>{formatDb(result?.lufsEstimate)}</strong></div><div className="metric"><span>Peak dBFS</span><strong>{formatDb(result?.peakDb)}</strong></div><div className="metric"><span>RMS dB</span><strong>{formatDb(result?.rmsDb)}</strong></div><div className="metric"><span>Clipping count</span><strong>{formatNumber(result?.clippingCount, 0)}</strong></div><div className="metric"><span>Duration (s)</span><strong>{formatNumber(result?.durationSec, 2)}</strong></div><div className="metric"><span>Sample rate</span><strong>{formatNumber(result?.sampleRate, 0)}</strong></div><div className="metric"><span>Channels</span><strong>{formatNumber(result?.channels, 0)}</strong></div><div className="metric span-2"><span>Low / Mid / High balance (rough)</span><strong>{formatNumber(result?.lowPercent, 0)} / {formatNumber(result?.midPercent, 0)} / {formatNumber(result?.highPercent, 0)}%</strong></div>
  </section>

  <section className="guidance"><h2>Selected Section Analysis</h2><p className="empty">Browser-based estimate only.</p>{sectionResult ? <><section className="metrics-grid"><div className="metric"><span>Readiness</span><strong><span className={`pill ${toneForReadiness(sectionResult.readiness)}`}>{sectionResult.readiness ?? '—'}</span></strong></div><div className="metric"><span>Score</span><strong>{formatScore(sectionResult.score)}</strong></div><div className="metric"><span>LUFS estimate</span><strong>{formatDb(sectionResult.lufsEstimate)}</strong></div><div className="metric"><span>Peak dBFS</span><strong>{formatDb(sectionResult.peakDb)}</strong></div><div className="metric"><span>RMS dB</span><strong>{formatDb(sectionResult.rmsDb)}</strong></div><div className="metric"><span>Clipping count</span><strong>{formatNumber(sectionResult.clippingCount, 0)}</strong></div><div className="metric span-2"><span>Low / Mid / High rough balance</span><strong>{formatNumber(sectionResult.lowPercent, 0)} / {formatNumber(sectionResult.midPercent, 0)} / {formatNumber(sectionResult.highPercent, 0)}%</strong></div></section>{sectionNarrative.map((n) => <p key={n}>{n}</p>)}<div className="verdicts section-verdicts"><ul>{[{ label: 'Loudness verdict', text: sectionResult.loudnessVerdict }, { label: 'Peak safety verdict', text: sectionResult.peakSafetyVerdict }, { label: 'Clipping warning', text: sectionResult.clippingVerdict }, { label: 'Low/Mid/High verdict', text: sectionResult.balanceVerdict }, { label: 'Mastering suggestion', text: sectionResult.masteringSuggestion }].filter((item) => Boolean(item.text)).map((item) => <li key={item.label}><span className="pill info">{item.label}</span><span>{item.text}</span></li>)}</ul></div><div className="workflow-row"><input className="note-input" value={problemNote} placeholder="Short problem note" onChange={(e) => setProblemNote(e.target.value)} /><button className="upload-btn" type="button" onClick={() => { if (!hasSelection || !sectionResult) return; setManualProblemAreas((prev) => [{ id: `${Date.now()}`, startSec: startSec ?? 0, endSec: endSec ?? 0, note: problemNote || 'Marked problem area', metrics: sectionResult }, ...prev]); setProblemNote(''); }}>Mark as problem area</button></div></> : <p className="empty">Select a valid start/end range, then analyze selected section.</p>}</section>

  <ReleaseChecklist result={result} autoMarkerCount={autoMarkers.length} />


  <section className="guidance"><h2>Plain English Summary</h2>{plainEnglishSummary ? <><h3>What you’re hearing</h3><ul>{plainEnglishSummary.hearing.map((item) => <li key={`hear-${item}`}>{item}</li>)}</ul><h3>Why it’s happening</h3><ul>{plainEnglishSummary.why.map((item) => <li key={`why-${item}`}>{item}</li>)}</ul><h3>What to do next</h3><ol>{plainEnglishSummary.next.map((item) => <li key={`next-${item}`}>{item}</li>)}</ol></> : <p className="empty">Run analysis to see a beginner-friendly summary.</p>}</section>


  <section className="guidance"><details><summary>Show technical details</summary>{result ? <div className="technical-details"><p>LUFS estimate: {formatDb(result.lufsEstimate)}</p><p>RMS dB: {formatDb(result.rmsDb)}</p><p>Channels: {formatNumber(result.channels, 0)}</p><p>Low / Mid / High: {formatNumber(result.lowPercent, 0)} / {formatNumber(result.midPercent, 0)} / {formatNumber(result.highPercent, 0)}%</p><p>Markers debug: {combinedProblemMarkers.map((m) => `${m.label}@${formatClock(m.timeSec)} (${m.kind})`).join(', ') || 'none'}</p></div> : <p className="empty">No analysis yet.</p>}</details></section>

  <section className="guidance"><h2>Target guidance</h2><p>Target LUFS: {TARGET_LUFS}. Safe peak target: below {SAFE_PEAK_DBFS} dBFS.</p><p>Browser-based estimate (including LUFS estimate), not a replacement for studio metering.</p></section>
</section></main>;
}
