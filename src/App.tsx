import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
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
type WorkerAudioData = { channels: Float32Array[]; sampleRate: number; durationSec: number };
type WorkerRequest =
  | { type: 'analyze'; payload: WorkerAudioData }
  | { type: 'analyzeSection'; payload: WorkerAudioData & { startSec: number; endSec: number } };


function buildSoundProfile(result: AnalysisResult | null): string {
  if (!result) return '—';

  const issues: string[] = [];
  const lufs = result.lufs ?? result.lufsEstimate;

  if (typeof lufs === 'number' && lufs < -20) issues.push('quiet');
  if (typeof result.rmsDb === 'number' && result.rmsDb < -20) issues.push('weak');
  if ((result.channels ?? 0) === 1) issues.push('mono');
  if (typeof result.lowPercent === 'number' && result.lowPercent < 15) issues.push('thin');
  if (typeof result.rmsDb === 'number' && result.rmsDb < -21 && (result.channels ?? 0) === 1) issues.push('low-fidelity');

  if (!issues.length) return 'Clean and balanced recording';

  const uniqueIssues = [...new Set(issues)];
  const descriptors = uniqueIssues.join(', ');
  const thinTail = uniqueIssues.includes('thin') ? ' with thin sound' : '';
  return `${descriptors} recording${thinTail}`.replace('thin recording with thin sound', 'recording with thin sound');
}

function buildWhyItSoundsThisWay(result: AnalysisResult | null): string[] {
  if (!result) return ['Run analysis to explain the current sound character.'];
  const reasons: string[] = [];
  const lufs = result.lufs ?? result.lufsEstimate;
  if (typeof lufs === 'number' && lufs < -20) reasons.push('Low volume makes the audio sound distant.');
  if (typeof result.rmsDb === 'number' && result.rmsDb < -20) reasons.push('Weak signal reduces presence and clarity.');
  if ((result.channels ?? 0) === 1) reasons.push('Mono removes stereo width and depth.');
  if (typeof result.lowPercent === 'number' && result.lowPercent < 15) reasons.push('Lack of low frequencies makes it sound thin.');
  if (typeof result.rmsDb === 'number' && result.rmsDb < -21) reasons.push('Background noise or compression reduces overall quality.');
  if (!reasons.length) return ['Loudness, tone balance, and stereo depth are in healthy ranges.'];
  return reasons.slice(0, 3);
}

function buildFixSuggestions(result: AnalysisResult | null): string[] {
  if (!result) return [];
  const fixes: string[] = [];
  const lufs = result.lufs ?? result.lufsEstimate;
  if (typeof lufs === 'number' && lufs < -20) fixes.push('Increase gain (+6 to +10 dB)');
  if (typeof result.rmsDb === 'number' && result.rmsDb < -20) fixes.push('Normalize audio or re-record with stronger input');
  if ((result.channels ?? 0) === 1) fixes.push('Apply stereo widening to restore space');
  if (typeof result.lowPercent === 'number' && result.lowPercent < 15) fixes.push('Boost bass (80–150 Hz)');
  if (typeof result.rmsDb === 'number' && result.rmsDb < -21) fixes.push('Apply noise reduction or denoise filter');
  fixes.push('Use EQ to clean mids (reduce muddiness around 300–800 Hz)');
  return fixes;
}

function detectAudioType(result: AnalysisResult | null): string {
  if (!result) return '—';
  const channels = result.channels ?? 0;
  const rms = result.rmsDb ?? -99;
  if (channels === 1 && rms < -20) return 'Likely old recording, phone capture, or tape source';
  if (rms < -21) return 'Low-quality recording with possible noise or compression artifacts';
  if (channels === 2 && rms > -18) return 'Modern digital recording';
  return 'Standard recording';
}



type CoachIssue = { label: string; severity: 'critical' | 'important' | 'optional' };
type SafeModeCoachPlan = {
  quickSummary: string[];
  startWith: string;
  whatIHear: string[];
  whatMatters: string[];
  whatToDoFirst: string[];
  whatNotToDo: string[];
  coachNote: string;
  issueSeverity: CoachIssue[];
};

function buildSafeModeFixPlan(result: AnalysisResult | null): SafeModeCoachPlan | null {
  if (!result) return null;

  const quickSummary: string[] = [];
  const whatIHear: string[] = [];
  const whatMatters: string[] = [];
  const whatToDoFirst: string[] = [];
  const whatNotToDo: string[] = [];
  const issueSeverity: CoachIssue[] = [];
  const startWithSteps: string[] = [];
  const lufs = result.lufsEstimate ?? result.lufs;
  const peak = result.peakDb;
  const rms = result.rmsDb;
  const channels = result.channels ?? 0;
  const low = result.lowPercent;
  const mid = result.midPercent;
  const high = result.highPercent;
  const clippingCount = result.clippingCount ?? 0;

  if (typeof lufs === 'number' && lufs < -16) {
    const gainDb = Math.max(1, Math.round(-14 - lufs));
    quickSummary.push('Slightly under loudness target');
    whatIHear.push(`Your track is slightly under target — a small gain boost of about ${gainDb} dB will improve presence.`);
    whatMatters.push('This may sound weak next to Spotify or YouTube releases.');
    whatToDoFirst.push(`Step ${whatToDoFirst.length + 1}: Raise input gain gently (+${gainDb} dB), then use a limiter to approach target loudness.`);
    issueSeverity.push({ label: 'Low loudness target', severity: 'important' });
    startWithSteps.push('adjust gain');
  } else if (typeof lufs === 'number' && lufs > -10) {
    quickSummary.push('Already very loud');
    whatIHear.push('Your track is already very loud and may be overworked if pushed more.');
    whatMatters.push('Extra loudness can increase fatigue and reduce dynamics.');
    issueSeverity.push({ label: 'Very high loudness', severity: 'important' });
  }

  if (typeof peak === 'number' && peak > -1) {
    quickSummary.push('Peaks are too hot');
    whatIHear.push('The loudest peaks are too hot and may distort.');
    whatMatters.push('Distortion may appear after export or streaming encoding.');
    whatToDoFirst.unshift(`Step 1: Lower limiter/output ceiling to -1 dBFS first (current peak ${peak.toFixed(1)} dBFS).`);
    issueSeverity.push({ label: 'Peak safety risk', severity: 'critical' });
    startWithSteps.unshift('lower ceiling');
  }

  if (clippingCount > 0) {
    quickSummary.push('Clipping detected');
    whatIHear.push('Some moments may crackle because clipping is present.');
    whatMatters.push('Clipping artifacts can sound harsh and unprofessional.');
    issueSeverity.push({ label: 'Clipping detected', severity: 'critical' });
  }

  if (typeof low === 'number' && typeof mid === 'number' && typeof high === 'number') {
    if (low < 22) {
      quickSummary.push('Low-end lacks warmth');
      whatIHear.push('The sound feels thin with limited low-end warmth.');
      whatMatters.push('Lack of bass reduces warmth and depth on full-range systems.');
      issueSeverity.push({ label: 'Thin low-end balance', severity: 'important' });
      whatToDoFirst.push(`Step ${whatToDoFirst.length + 1}: After gain staging, add a gentle EQ boost around 80–150 Hz and re-check balance.`);
      startWithSteps.push('balance EQ');
    } else if (low > 44) {
      whatIHear.push('The low-end is heavy and can blur the mix.');
      whatMatters.push('Boomy bass can mask vocals and reduce clarity.');
      issueSeverity.push({ label: 'Heavy low-end balance', severity: 'important' });
      whatToDoFirst.push(`Step ${whatToDoFirst.length + 1}: After peak/loudness fixes, cut muddy lows gently before adding more level.`);
    } else if (high < 18) {
      whatIHear.push('The top-end is muted and lacks sparkle.');
      whatMatters.push('Muted highs may reduce clarity and presence.');
      issueSeverity.push({ label: 'Muted high-end', severity: 'optional' });
    } else if (mid > 65) {
      whatIHear.push('Midrange dominates, which can feel boxy.');
      whatMatters.push('Too much low-mid energy can reduce openness.');
      issueSeverity.push({ label: 'Boxy midrange', severity: 'optional' });
    }
  }

  if (channels === 1 || (typeof rms === 'number' && rms < -21)) {
    whatIHear.push('The track feels narrow and low-fidelity in places.');
    whatMatters.push('Limited width can make it feel small compared with modern stereo tracks.');
    whatToDoFirst.push(`Step ${whatToDoFirst.length + 1}: If mono is not intentional, apply subtle stereo widening after gain and peak control.`);
    issueSeverity.push({ label: 'Mono/low-fidelity image', severity: 'optional' });
  }

  whatNotToDo.push('Do not push loudness before fixing clipping or unsafe peaks.');
  if (channels === 1 || (typeof rms === 'number' && rms < -21)) whatNotToDo.push('Avoid over-compressing low-quality or mono sources.');
  if (typeof low === 'number' && low < 22) whatNotToDo.push('Do not over-boost bass — use small EQ moves and level-match.');

  if (!whatIHear.length) whatIHear.push('Your track sounds balanced and close to release-safe levels.');
  if (!whatMatters.length) whatMatters.push('This should translate well across streaming playback systems.');
  if (!whatToDoFirst.length) whatToDoFirst.push('Step 1: Do a final reference check on headphones and speakers.');

  return {
    quickSummary: quickSummary.slice(0, 3),
    startWith: startWithSteps.length ? `👉 Start with: ${[...new Set(startWithSteps)].slice(0, 3).join(' → ')}` : '👉 Start with: Reference check → gentle polish → final export',
    whatIHear,
    whatMatters,
    whatToDoFirst,
    whatNotToDo: whatNotToDo.slice(0, 3),
    coachNote: issueSeverity.some((x) => x.severity === 'critical') ? 'You are close — fix the critical items first and the track will improve quickly.' : 'This track has good potential, just needs small refinements.',
    issueSeverity
  };
}

function buildAutoFixPlan(result: AnalysisResult): { wrong: string[]; matters: string[]; first: string[]; avoid: string[]; readiness: string[] } {
  const wrong: string[] = [];
  const matters: string[] = [];
  const first: string[] = [];
  const avoid: string[] = [];
  const readiness: string[] = [];

  const lufs = result.lufsEstimate ?? result.lufs;
  const peak = result.peakDb;
  const rms = result.rmsDb;
  const channels = result.channels ?? 0;
  const low = result.lowPercent;
  const mid = result.midPercent;
  const high = result.highPercent;
  const clippingCount = result.clippingCount ?? 0;

  if (typeof lufs === 'number' && lufs < -16) {
    wrong.push('This track is too quiet for release.');
    matters.push('It may sound weak next to songs on Spotify or YouTube.');
    first.push('Add gentle gain or limiting in small steps, and compare with a reference track.');
  }
  if (typeof peak === 'number' && peak > -1) {
    wrong.push('The loudest peaks are too hot.');
    matters.push('Peaks this high can cause distortion after encoding.');
    first.push('Set your limiter/output ceiling to -1 dBFS or lower.');
  }
  if (clippingCount > 0) {
    wrong.push('Clipping was detected in this file.');
    matters.push('Clipping can add crackle and harsh edges that listeners notice quickly.');
    first.push('Reduce limiter drive or master gain, then export and re-check clipping count.');
  }
  if (typeof low === 'number' && low < 22) {
    wrong.push('The low-end is thin.');
    matters.push('The track may feel small or lacking warmth.');
    first.push('Try a small low-end EQ boost around 80–150 Hz, then level-match and listen again.');
  }
  if (typeof low === 'number' && low > 44) {
    wrong.push('There is too much low-end buildup.');
    matters.push('Boomy bass can mask vocals and reduce clarity on small speakers.');
    first.push('Cut muddy lows gently before adding more loudness.');
  }
  if (typeof high === 'number' && high < 18) {
    wrong.push('The high-end is a bit muted.');
    matters.push('Muted highs can reduce clarity and sparkle.');
    first.push('Use a gentle high-shelf boost and stop as soon as clarity improves.');
  }
  if (channels === 1) {
    wrong.push('This file is mono.');
    matters.push('Mono can feel narrow compared with modern stereo releases.');
    first.push('Confirm mono is intentional before trying any widening.');
    avoid.push('Do not over-compress this recording because mono and low-fidelity sources break up faster.');
  }
  if (typeof rms === 'number' && rms < -21) {
    wrong.push('The average signal level is very low.');
    matters.push('Low RMS often means weak presence and higher noise risk when boosted.');
    first.push('Recommended first step: clean noise, then rebalance EQ, then adjust loudness.');
    avoid.push('Do not stack heavy compression and limiting at the same time on a weak source.');
  }
  if (typeof mid === 'number' && mid > 65) {
    avoid.push('Do not keep boosting mids if the track already sounds boxy.');
  }

  if (!avoid.length) {
    avoid.push('Do not chase loudness first—fix clipping and tonal balance before final limiting.');
  }

  const readinessLabel = result.readiness ?? 'Needs Work';
  const scoreText = typeof result.score === 'number' ? `${Math.round(result.score)} / 100` : 'not scored yet';
  readiness.push(`Current release readiness: ${readinessLabel} (${scoreText}).`);
  if (result.masteringSuggestion) readiness.push(`Mastering suggestion: ${result.masteringSuggestion}`);
  if (result.loudnessVerdict) readiness.push(`Loudness check: ${result.loudnessVerdict}`);
  if (result.balanceVerdict) readiness.push(`Balance check: ${result.balanceVerdict}`);
  if (result.clippingVerdict) readiness.push(`Clipping check: ${result.clippingVerdict}`);

  if (!wrong.length) {
    wrong.push('No major issues were detected in the current analysis.');
    matters.push('Your loudness, peaks, and balance look close to release-safe ranges.');
    first.push('Do one last reference check on headphones and speakers before release.');
  }

  return { wrong, matters, first, avoid, readiness };
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
  const [safeModeFixPlan, setSafeModeFixPlan] = useState<SafeModeCoachPlan | null>(null);
  const [manualProblemAreas, setManualProblemAreas] = useState<ProblemArea[]>([]);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [autoMarkers, setAutoMarkers] = useState<ProblemMarker[]>([]);
  const [status, setStatus] = useState('Upload audio to start analysis.');
  const [analysisStatus, setAnalysisStatus] = useState<'idle' | 'processing' | 'complete' | 'failed'>('idle');
  const [loading, setLoading] = useState(false);
  const [analysisStage, setAnalysisStage] = useState('Idle');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [largeFileWarning, setLargeFileWarning] = useState('');
  const [fileName, setFileName] = useState('No file selected');
  const [seekToSec, setSeekToSec] = useState<number | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const audioDataRef = useRef<WorkerAudioData | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);
  useEffect(() => {
    workerRef.current = new Worker(new URL('./workers/audioWorker.ts', import.meta.url), { type: 'module' });
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  const runWorkerRequest = useCallback((request: WorkerRequest, transfer: Transferable[] = []) => new Promise<MessageEvent>((resolve, reject) => {
    const worker = workerRef.current;
    if (!worker) {
      reject(new Error('Worker unavailable'));
      return;
    }
    const requestId = ++requestIdRef.current;
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.requestId !== requestId) return;
      if (event.data.type === 'stage') {
        setAnalysisStage(event.data.stage);
        return;
      }
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
      resolve(event);
    };
    const handleError = () => {
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
      reject(new Error('Worker failed'));
    };
    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleError);
    worker.postMessage({ ...request, requestId }, transfer);
  }), []);

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
    setLoading(true); setIsAnalyzing(true); setFileName(file.name); setStatus('Analyzing…'); setAnalysisStatus('processing'); setAnalysisStage('Loading audio'); setLargeFileWarning('');
    setSectionResult(null); setStartSec(null); setEndSec(null); setManualProblemAreas([]); setProblemNote(''); setResult(null); setAutoMarkers([]);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    const url = URL.createObjectURL(file); setAudioUrl(url);
    setAudioBuffer(null); audioDataRef.current = null;
    setCurrentTime(0);
    setDuration(0);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const audioContext = new AudioContext();
      const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
      await audioContext.close();
      setAudioBuffer(decoded);
      const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => new Float32Array(decoded.getChannelData(i)));
      const workerData = { channels, sampleRate: decoded.sampleRate, durationSec: decoded.duration };
      audioDataRef.current = workerData;
      setAnalysisStage('Reading waveform');
      const transfer = channels.map((channel) => channel.buffer as Transferable);
      const msg = await runWorkerRequest({ type: 'analyze', payload: workerData }, transfer);
      if (msg.data.type !== 'done') throw new Error('Invalid worker response');
      setResult(msg.data.result);
      setAutoMarkers(msg.data.markers);
      if (msg.data.isLargeFile) setLargeFileWarning('Large file detected — analysis may take longer.');
      setDuration(decoded.duration); setCurrentTime(0);
      setStatus('Analysis complete');
      setAnalysisStatus('complete');
    } catch {
      setResult(null); setAudioBuffer(null); setStatus('Audio ready for playback'); audioDataRef.current = null;
      setAnalysisStatus('failed');
    } finally { setLoading(false); setIsAnalyzing(false); event.target.value = ''; }
  }

  const analyzeSelectedSection = useCallback(async () => {
    if (!hasSelection || !audioDataRef.current || !workerRef.current) return;
    setLoading(true);
    setIsAnalyzing(true);
    await runWorkerRequest({ type: 'analyzeSection', payload: { ...audioDataRef.current, startSec: startSec ?? 0, endSec: endSec ?? 0 } })
      .then((msg) => {
        if (msg.data.type === 'sectionDone') setSectionResult(msg.data.sectionResult);
      })
      .finally(() => { setLoading(false); setIsAnalyzing(false); });
  }, [hasSelection, startSec, endSec, runWorkerRequest]);

  const sectionNarrative = sectionResult && result ? [
    `Problem area detected from ${formatClock(startSec)} to ${formatClock(endSec)}.`,
    sectionResult.lufsEstimate && result.lufsEstimate && sectionResult.lufsEstimate > result.lufsEstimate ? 'This section is louder than the whole track.' : 'This section is not louder than the whole track.',
    sectionResult.lowPercent && result.lowPercent && sectionResult.lowPercent > result.lowPercent ? 'This section has more low-end build-up.' : 'Low-end is not more built-up than full track.',
    sectionResult.highPercent && result.highPercent && sectionResult.highPercent < result.highPercent ? 'This section has reduced clarity / high-end energy.' : 'High-end clarity is similar or higher than full track.'
  ] : [];
  const hasAnalyzedTrack = Boolean(result);
  const plainEnglishSummary = result ? buildPlainEnglishSummary(result) : null;
  const autoFixPlan = result ? buildAutoFixPlan(result) : null;
  const runSafeModeAutoFix = useCallback(() => {
    setSafeModeFixPlan(buildSafeModeFixPlan(result));
  }, [result]);
  const soundProfile = buildSoundProfile(result);
  const whyItSoundsThisWay = buildWhyItSoundsThisWay(result);
  const fixSuggestions = buildFixSuggestions(result);
  const audioType = detectAudioType(result);
  const markerGuidance: Record<string, { title: string; explanation: string; fix: string; badgeTone: 'bad' | 'warn' }> = {
    'Too quiet → +8 dB gain': {
      title: 'Volume too low',
      explanation: 'This part may sound too quiet compared with other songs.',
      fix: 'Increase gain +8 dB',
      badgeTone: 'bad'
    },
    'Weak signal → Normalize audio': {
      title: 'Weak recording quality',
      explanation: 'This section lacks strength and presence.',
      fix: 'Normalize audio',
      badgeTone: 'warn'
    },
    'Mono → Add stereo width': {
      title: 'Flat / mono sound',
      explanation: 'The sound feels narrow and has little stereo space.',
      fix: 'Add stereo width',
      badgeTone: 'warn'
    },
    'Thin low-end → Boost 80–150 Hz': {
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


  return <main className="app-shell"><section className="card compact"><header className="topbar"><div><div className="brand-row"><span className="brand-icon" aria-hidden="true"><svg viewBox="0 0 64 64" role="img"><path d="M12 38V31C12 19.4 21.4 10 33 10s21 9.4 21 21v7" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round"/><rect x="9" y="33" width="11" height="20" rx="5" fill="currentColor"/><rect x="46" y="33" width="11" height="20" rx="5" fill="currentColor"/></svg></span><h1>Studio Sense</h1></div><p className="subhead">Interactive listening + section mastering check</p></div><label className="upload-btn" htmlFor="audio-upload">{isAnalyzing ? 'Analyzing…' : 'Upload audio'}</label><input id="audio-upload" type="file" accept="audio/*" onChange={onFileChange} disabled={loading} /></header>
  <section className="workflow-row"><span className="filename">File: {fileName}</span><span className={`pill ${loading ? 'info' : 'good'}`}>{loading ? 'Processing' : 'Ready'}</span></section><p className="status">{status}</p>{isAnalyzing ? <p className="status">Analyzing…</p> : null}<p className="status">{analysisStatus === 'processing' ? `Analyzing audio… please wait (${analysisStage})` : analysisStatus === 'complete' ? 'Analysis complete' : analysisStatus === 'failed' ? 'Analysis failed (playback may still work).' : 'Upload audio to begin analysis.'}</p>{largeFileWarning ? <p className="status">{largeFileWarning}</p> : null}

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
    <div className="workflow-row"><button className="upload-btn" type="button" disabled={loading || !audioBuffer || !hasSelection} onClick={analyzeSelectedSection}>Analyze selected section</button></div>
  </section>

  <section className="metrics-grid">
    <div className="metric"><span>Readiness</span><strong><span className={`pill ${toneForReadiness(result?.readiness)}`}>{result?.readiness ?? '—'}</span></strong></div><div className="metric"><span>Score</span><strong>{formatScore(result?.score)}</strong></div><div className="metric"><span>LUFS estimate</span><strong>{formatDb(result?.lufsEstimate)}</strong></div><div className="metric"><span>Peak dBFS</span><strong>{formatDb(result?.peakDb)}</strong></div><div className="metric"><span>RMS dB</span><strong>{formatDb(result?.rmsDb)}</strong></div><div className="metric"><span>Clipping count</span><strong>{formatNumber(result?.clippingCount, 0)}</strong></div><div className="metric"><span>Duration (s)</span><strong>{formatNumber(result?.durationSec, 2)}</strong></div><div className="metric"><span>Sample rate</span><strong>{formatNumber(result?.sampleRate, 0)}</strong></div><div className="metric"><span>Channels</span><strong>{formatNumber(result?.channels, 0)}</strong></div><div className="metric span-2"><span>Low / Mid / High balance (rough)</span><strong>{formatNumber(result?.lowPercent, 0)} / {formatNumber(result?.midPercent, 0)} / {formatNumber(result?.highPercent, 0)}%</strong></div>
  </section>

  <section className="guidance"><h2>Selected Section Analysis</h2><p className="empty">Browser-based estimate only.</p>{sectionResult ? <><section className="metrics-grid"><div className="metric"><span>Readiness</span><strong><span className={`pill ${toneForReadiness(sectionResult.readiness)}`}>{sectionResult.readiness ?? '—'}</span></strong></div><div className="metric"><span>Score</span><strong>{formatScore(sectionResult.score)}</strong></div><div className="metric"><span>LUFS estimate</span><strong>{formatDb(sectionResult.lufsEstimate)}</strong></div><div className="metric"><span>Peak dBFS</span><strong>{formatDb(sectionResult.peakDb)}</strong></div><div className="metric"><span>RMS dB</span><strong>{formatDb(sectionResult.rmsDb)}</strong></div><div className="metric"><span>Clipping count</span><strong>{formatNumber(sectionResult.clippingCount, 0)}</strong></div><div className="metric span-2"><span>Low / Mid / High rough balance</span><strong>{formatNumber(sectionResult.lowPercent, 0)} / {formatNumber(sectionResult.midPercent, 0)} / {formatNumber(sectionResult.highPercent, 0)}%</strong></div></section>{sectionNarrative.map((n) => <p key={n}>{n}</p>)}<div className="verdicts section-verdicts"><ul>{[{ label: 'Loudness verdict', text: sectionResult.loudnessVerdict }, { label: 'Peak safety verdict', text: sectionResult.peakSafetyVerdict }, { label: 'Clipping warning', text: sectionResult.clippingVerdict }, { label: 'Low/Mid/High verdict', text: sectionResult.balanceVerdict }, { label: 'Mastering suggestion', text: sectionResult.masteringSuggestion }].filter((item) => Boolean(item.text)).map((item) => <li key={item.label}><span className="pill info">{item.label}</span><span>{item.text}</span></li>)}</ul></div><div className="workflow-row"><input className="note-input" value={problemNote} placeholder="Short problem note" onChange={(e) => setProblemNote(e.target.value)} /><button className="upload-btn" type="button" onClick={() => { if (!hasSelection || !sectionResult) return; setManualProblemAreas((prev) => [{ id: `${Date.now()}`, startSec: startSec ?? 0, endSec: endSec ?? 0, note: problemNote || 'Marked problem area', metrics: sectionResult }, ...prev]); setProblemNote(''); }}>Mark as problem area</button></div></> : <p className="empty">Select a valid start/end range, then analyze selected section.</p>}</section>

  <ReleaseChecklist result={result} autoMarkerCount={autoMarkers.length} />


  <section className="guidance"><h2>Plain English Summary</h2>{plainEnglishSummary ? <><h3>What you’re hearing</h3><ul>{plainEnglishSummary.hearing.map((item) => <li key={`hear-${item}`}>{item}</li>)}</ul><h3>Why it’s happening</h3><ul>{plainEnglishSummary.why.map((item) => <li key={`why-${item}`}>{item}</li>)}</ul><h3>What to do next</h3><ol>{plainEnglishSummary.next.map((item) => <li key={`next-${item}`}>{item}</li>)}</ol></> : <p className="empty">Run analysis to see a beginner-friendly summary.</p>}</section>

  <section className="guidance"><h2>Auto Fix Plan</h2>{autoFixPlan ? <><h3>1) What is wrong</h3><ul>{autoFixPlan.wrong.map((item) => <li key={`wrong-${item}`}>{item}</li>)}</ul><h3>2) Why it matters</h3><ul>{autoFixPlan.matters.map((item) => <li key={`matters-${item}`}>{item}</li>)}</ul><h3>3) What to try first</h3><ol>{autoFixPlan.first.map((item) => <li key={`first-${item}`}>{item}</li>)}</ol><h3>4) What NOT to do</h3><ul>{autoFixPlan.avoid.map((item) => <li key={`avoid-${item}`}>{item}</li>)}</ul><h3>5) Release readiness</h3><ul>{autoFixPlan.readiness.map((item) => <li key={`ready-${item}`}>{item}</li>)}</ul></> : <p className="empty">Run analysis to generate a beginner-friendly repair plan.</p>}</section>

  <section className="guidance"><h2>Target guidance</h2><p>Target LUFS: {TARGET_LUFS}. Safe peak target: below {SAFE_PEAK_DBFS} dBFS.</p><p>Browser-based estimate (including LUFS estimate), not a replacement for studio metering.</p></section>

  <section className="guidance"><h2>Listening Coach (Safe Mode)</h2><div className="workflow-row"><button className="upload-btn" type="button" onClick={runSafeModeAutoFix} disabled={!result}>🎯 Improve My Track</button></div>{safeModeFixPlan ? <><h3>🎧 Quick Coach Summary</h3>{safeModeFixPlan.quickSummary.length ? <ul>{safeModeFixPlan.quickSummary.map((item) => <li key={`quick-${item}`}>{item}</li>)}</ul> : <p>• No major red flags detected.</p>}<p><strong>{safeModeFixPlan.startWith}</strong></p><h3>Issue Priority</h3><ul>{safeModeFixPlan.issueSeverity.map((item) => <li key={`severity-${item.label}`}><span className={`pill ${item.severity === 'critical' ? 'bad' : item.severity === 'important' ? 'warn' : 'good'}`}>{item.severity === 'critical' ? '🔴 Critical' : item.severity === 'important' ? '🟠 Important' : '🟢 Optional'}</span> <span>{item.label}</span></li>)}</ul><h3>🎧 WHAT I HEAR</h3><ul>{safeModeFixPlan.whatIHear.map((item) => <li key={`hear-${item}`}>{item}</li>)}</ul><h3>⚠️ WHAT MATTERS</h3><ul>{safeModeFixPlan.whatMatters.map((item) => <li key={`matters-${item}`}>{item}</li>)}</ul><h3>🛠️ WHAT TO DO FIRST (PRIORITY ORDER)</h3><ol>{safeModeFixPlan.whatToDoFirst.map((item) => <li key={`first-${item}`}>{item}</li>)}</ol><h3>🚫 WHAT NOT TO DO</h3><ul>{safeModeFixPlan.whatNotToDo.map((item) => <li key={`avoid-${item}`}>{item}</li>)}</ul><h3>🎯 COACH NOTE</h3><p>{safeModeFixPlan.coachNote}</p></> : <p className="empty">Run analysis, then tap “🎯 Improve My Track” for a structured listening coach plan.</p>}</section>
</section></main>;
}
