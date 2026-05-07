import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import AudioPlayer from './AudioPlayer';
import ReleaseChecklist from './ReleaseChecklist';
import ListeningCoach from './ListeningCoach';

type ReadinessCategory = 'Release Ready' | 'Needs Work' | 'Problem Area';
type SourceQualityCategory = 'Low Fidelity Source' | 'Standard Compressed Audio' | 'Good Production Source' | 'Professional Studio Source';
type MasteringReadinessCategory = 'Release Ready' | 'Needs Work' | 'Not Mastered' | 'Not Recommended';
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
type SourceQualityAssessment = {
  rating: SourceQualityCategory;
  confidence: number;
  masteringReadiness: MasteringReadinessCategory;
  sourceTypeGuess: string;
  note: string;
  notMasteredYet: boolean;
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

type SourceContext = {
  isWav: boolean;
  isCompressed: boolean;
  isMono: boolean;
  isStemName: boolean;
  isVocalStem: boolean;
  isInstrumentStem: boolean;
  isLikelyStem: boolean;
  isStemKeywordWav: boolean;
  archivalSignalCount: number;
  poorSpectralIndicators: number;
};

function getSourceContext(result: AnalysisResult, fileName: string): SourceContext {
  const normalizedName = fileName.toLowerCase();
  const extension = normalizedName.split('.').pop() ?? '';
  const isWav = extension === 'wav' || extension === 'wave';
  const isCompressed = ['mp3', 'm4a', 'aac', 'ogg'].includes(extension);
  const isMono = (result.channels ?? 0) === 1;
  const isStemName = /(acappella|vocal|vox|stem|multitrack|closemic|mic|di|raw|saxophone|drums|bass|guitar|piano|overhead|room)/i.test(normalizedName);
  const isVocalStem = /(acappella|vocal|vox)/i.test(normalizedName);
  const isInstrumentStem = /(saxophone|drums|bass|guitar|piano|overhead|room|di|closemic)/i.test(normalizedName);
  const low = result.lowPercent;
  const high = result.highPercent;
  const archivalName = /(tape|cassette|transfer|copy|dub|archive|archival|old|phone)/i.test(normalizedName);
  const weakRms = typeof result.rmsDb === 'number' && result.rmsDb < -22;
  const unstablePeaks = (result.clippingCount ?? 0) > 6;
  const severeRolloff = typeof high === 'number' && high < 8;
  const cassetteLikeBalance = (typeof low === 'number' && low > 55) || (typeof low === 'number' && low < 10);
  const noisyHighs = typeof high === 'number' && high > 45;
  const compressedArchival = isCompressed && archivalName;
  const poorSpectralIndicators = [severeRolloff, cassetteLikeBalance, noisyHighs].filter(Boolean).length;
  const archivalSignalCount = [archivalName, isMono, weakRms, unstablePeaks, severeRolloff, cassetteLikeBalance, noisyHighs, compressedArchival].filter(Boolean).length;
  return { isWav, isCompressed, isMono, isStemName, isVocalStem, isInstrumentStem, isLikelyStem: isWav && isStemName, isStemKeywordWav: isWav && isStemName, archivalSignalCount, poorSpectralIndicators };
}


function buildSoundProfile(result: AnalysisResult | null, fileName: string): string {
  if (!result) return '—';
  const context = getSourceContext(result, fileName);
  const cleanMonoStem = context.isMono && context.isWav && (result.clippingCount ?? 0) === 0 && context.poorSpectralIndicators < 2;
  if (context.isStemKeywordWav) return 'Raw studio stem / multitrack source';
  if (cleanMonoStem) return 'Mono studio stem';
  if (context.isVocalStem) return 'Raw vocal stem';
  if (context.isInstrumentStem || context.isLikelyStem) return 'Raw instrument stem';
  if (context.isMono && context.isWav) return 'Mono studio source';
  if (context.isCompressed) return 'Streaming compressed source';
  if (context.archivalSignalCount >= 4) return 'Archival transfer';
  if ((result.channels ?? 0) >= 2 && context.isWav) return 'Finished stereo master';

  const issues: string[] = [];
  const lufs = result.lufs ?? result.lufsEstimate;

  if (typeof lufs === 'number' && lufs < -20) issues.push('quiet');
  if (typeof result.rmsDb === 'number' && result.rmsDb < -20) issues.push('weak');
  if ((result.channels ?? 0) === 1) issues.push('mono');
  if (typeof result.lowPercent === 'number' && result.lowPercent < 15) issues.push('thin');
  if (typeof result.rmsDb === 'number' && result.rmsDb < -21 && (result.channels ?? 0) === 1 && !cleanMonoStem) issues.push('low-fidelity');

  if (!issues.length) return 'Clean and balanced recording';

  const uniqueIssues = [...new Set(issues)];
  const descriptors = uniqueIssues.join(', ');
  const thinTail = uniqueIssues.includes('thin') ? ' with thin sound' : '';
  return `${descriptors} recording${thinTail}`.replace('thin recording with thin sound', 'recording with thin sound');
}

function buildWhyItSoundsThisWay(result: AnalysisResult | null): string[] {
  if (!result) return ['Run analysis to explain the current sound character.'];
  const reasons: string[] = [];
  const cleanMonoStem = (result.channels ?? 0) === 1
    && (result.clippingCount ?? 0) === 0
    && (typeof result.highPercent !== 'number' || result.highPercent >= 8)
    && (typeof result.lowPercent !== 'number' || (result.lowPercent >= 10 && result.lowPercent <= 55));
  const lufs = result.lufs ?? result.lufsEstimate;
  if (typeof lufs === 'number' && lufs < -20) reasons.push('Low volume makes the audio sound distant.');
  if (typeof result.rmsDb === 'number' && result.rmsDb < -20) reasons.push('Weak signal reduces presence and clarity.');
  if ((result.channels ?? 0) === 1) reasons.push('Mono removes stereo width and depth.');
  if (typeof result.lowPercent === 'number' && result.lowPercent < 15) reasons.push('Lack of low frequencies makes it sound thin.');
  if (typeof result.rmsDb === 'number' && result.rmsDb < -21 && !cleanMonoStem) reasons.push('Background noise or compression reduces overall quality.');
  if (!reasons.length) return ['Loudness, tone balance, and stereo depth are in healthy ranges.'];
  return reasons.slice(0, 3);
}

function buildFixSuggestions(result: AnalysisResult | null): string[] {
  if (!result) return [];
  const fixes: string[] = [];
  const lufs = result.lufs ?? result.lufsEstimate;
  if (typeof lufs === 'number' && lufs < -20) fixes.push('Turn the track up slowly, then check it still sounds clean.');
  if (typeof result.rmsDb === 'number' && result.rmsDb < -20) fixes.push('Normalize audio or re-record with stronger input');
  if ((result.channels ?? 0) === 1) fixes.push('Apply stereo widening to restore space');
  if (typeof result.lowPercent === 'number' && result.lowPercent < 15) fixes.push('Add a little warmth if the track feels thin, but keep it subtle.');
  if (typeof result.rmsDb === 'number' && result.rmsDb < -21) fixes.push('Apply noise reduction or denoise filter');
  fixes.push('If the track sounds muddy or cloudy, gently clean that area.');
  return fixes;
}

function detectAudioType(result: AnalysisResult | null, fileName: string): string {
  if (!result) return '—';
  const context = getSourceContext(result, fileName);
  const channels = result.channels ?? 0;
  const rms = result.rmsDb;
  const clippingCount = result.clippingCount ?? 0;
  const sampleRate = result.sampleRate ?? 0;

  const lowRms = typeof rms === 'number' && rms < -22;
  const weakRms = typeof rms === 'number' && rms < -20;
  const safePeaks = typeof result.peakDb === 'number' && result.peakDb <= -1;
  const cleanSampleRate = sampleRate === 44100 || sampleRate === 48000;

  if (context.isStemKeywordWav || context.isVocalStem) {
    return 'Raw studio stem / multitrack source — This is likely a raw stem, not a finished master.';
  }

  if (context.isLikelyStem) {
    return 'Raw instrument stem — This source appears to be a raw isolated track rather than a finished master.';
  }

  if (context.isWav && channels === 1 && clippingCount === 0 && safePeaks && context.poorSpectralIndicators < 2) {
    return 'Mono studio stem — Not release-ready by itself, but usable in a mix.';
  }

  if (context.isWav && cleanSampleRate && clippingCount === 0 && safePeaks && context.archivalSignalCount < 4) {
    return 'Finished stereo master / modern digital source';
  }

  if (context.isMono && lowRms && context.poorSpectralIndicators >= 2 && context.archivalSignalCount >= 5) {
    return 'Archival transfer / old tape source — Multiple indicators suggest analog age or transfer limitations.';
  }

  if (context.isCompressed && (weakRms || clippingCount > 0 || lowRms)) return 'Streaming compressed source';
  if (channels >= 2 && typeof rms === 'number' && rms > -19) return 'Finished stereo master / modern digital source';
  return 'Modern digital recording';
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

type ListeningCoachingMode = {
  modeName: string;
  intro: string;
  dynamicFeedback: string[];
  fixOrder: string[];
};

type AppMode = 'beginner' | 'creator';


type PriorityFix = {
  title: string;
  message: string;
};

function getPriorityFix(analysis: AnalysisResult | null): PriorityFix | null {
  if (!analysis) return null;

  const clippingCount = analysis.clippingCount ?? 0;
  const peakDb = analysis.peakDb;
  const lufs = analysis.lufs ?? analysis.lufsEstimate;
  const lowBalance = analysis.lowPercent ?? 0;
  const highBalance = analysis.highPercent ?? 0;

  if (clippingCount > 0 || (typeof peakDb === 'number' && peakDb >= -1)) {
    return {
      title: 'Fix Peaks First',
      message: 'Your track is hitting unsafe levels. Lower limiter ceiling to -1 dBFS or below before doing anything else.'
    };
  }

  if (typeof lufs === 'number' && lufs < -14) {
    return {
      title: 'Increase Loudness',
      message: 'Your track is too quiet. Add gain or limiting gradually to reach streaming level.'
    };
  }

  if (lowBalance < 20) {
    return {
      title: 'Fix Low-End',
      message: 'Your track lacks bass. Try boosting 80–150 Hz gently.'
    };
  }

  if (highBalance < 20) {
    return {
      title: 'Fix Clarity',
      message: 'Your track lacks brightness. Add a gentle high-shelf EQ.'
    };
  }

  return {
    title: 'Final Polish',
    message: 'Your track is balanced. Compare with a reference track before release.'
  };
}

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
    whatToDoFirst.unshift(`Step 1: Set your limiter/output so the loudest parts stay below -1 dB. (current peak ${peak.toFixed(1)} dBFS).`);
    issueSeverity.push({ label: 'Peak safety risk', severity: 'critical' });
    startWithSteps.unshift('set limiter/output ceiling');
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
      whatToDoFirst.push(`Step ${whatToDoFirst.length + 1}: After gain staging, add a little bass warmth around 80–150 Hz. Keep it gentle so the track does not get muddy.`);
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
    whatToDoFirst: whatToDoFirst.slice(0, 4),
    whatNotToDo: whatNotToDo.slice(0, 3),
    coachNote: issueSeverity.some((x) => x.severity === 'critical') ? 'You are close — fix the critical items first and the track will improve quickly.' : 'This track has good potential, just needs small refinements.',
    issueSeverity
  };
}

function buildAutoFixPlan(result: AnalysisResult, sourceQuality: SourceQualityAssessment | null): { wrong: string[]; matters: string[]; first: string[]; listenFor: string[]; avoid: string[]; readiness: string[]; sourceQuality: string[] } {
  const wrong: string[] = [];
  const matters: string[] = [];
  const first: string[] = [];
  const listenFor: string[] = [
    'Does it feel as loud as other songs?',
    'Does the bass feel full but not heavy?',
    'Do vocals and instruments stay clear?',
    'Do loud parts stay clean without crunch or distortion?'
  ];
  const avoid: string[] = [];
  const readiness: string[] = [];
  const sourceQualityNotes: string[] = [];

  const lufs = result.lufsEstimate ?? result.lufs;
  const peak = result.peakDb;
  const rms = result.rmsDb;
  const channels = result.channels ?? 0;
  const low = result.lowPercent;
  const clippingCount = result.clippingCount ?? 0;

  if (typeof peak === 'number' && peak > -1) {
    wrong.push('The loudest peaks are too hot.');
    matters.push('Peaks this high can distort after export.');
    first.push(`Set your limiter so the loudest parts stay below -1 dB (now ${peak.toFixed(1)} dBFS). Listen to the loudest section and make sure it stays clean. Stop if you hear crunch.`);
  }
  if (clippingCount > 0) {
    wrong.push('Clipping was detected in this file.');
    matters.push('Clipping adds crackle and harsh edges.');
    first.push('Back off limiter drive or master gain. Listen for cleaner transients and less crackle. Stop when clipping is gone.');
  }
  if (typeof lufs === 'number' && lufs < -16) {
    const gainDb = Math.max(1, Math.round(-14 - lufs));
    wrong.push('This track is too quiet for release.');
    matters.push('It may sound weak next to streaming songs.');
    first.push(`Turn the track up slowly by about ${gainDb} dB. Listen for it to feel closer in volume to reference songs. Stop if it starts sounding harsh or flat.`);
  }
  if (typeof low === 'number' && low < 22) {
    wrong.push('The low-end is thin.');
    matters.push('The track may feel small and cold.');
    first.push('If the track feels thin, add a little bass warmth. Listen for more fullness. Stop before it turns boomy or muddy.');
  }
  if (typeof low === 'number' && low > 44) {
    wrong.push('There is too much low-end buildup.');
    matters.push('Boomy bass can hide vocals and detail.');
    first.push('Gently reduce muddy lows. Listen for clearer vocals and tighter bass. Stop when the mix feels balanced, not thin.');
  }

  if (channels === 1) avoid.push('Do not force wide stereo effects if mono is intentional.');
  if (typeof rms === 'number' && rms < -21) avoid.push('Do not stack heavy compression and limiting on a weak source.');
  if (!avoid.length) avoid.push('Do not chase loudness before peak safety and clipping are clean.');

  const readinessLabel = result.readiness ?? 'Needs Work';
  const scoreText = typeof result.score === 'number' ? `${Math.round(result.score)} / 100` : 'not scored yet';
  if (sourceQuality) sourceQualityNotes.push(`Source quality: ${sourceQuality.rating}. ${sourceQuality.note}`);
  readiness.push(`Current release readiness: ${readinessLabel} (${scoreText}).`);

  if (!wrong.length) {
    wrong.push('No major issues were detected in the current analysis.');
    matters.push('Your loudness, peaks, and tone look close to release-safe ranges.');
    first.push('Do a quick reference check. Listen for clean peaks, clear vocals, and balanced bass. Stop when it already feels right.');
  }

  return { wrong, matters, first: first.slice(0, 4), listenFor, avoid: avoid.slice(0, 3), readiness: readiness.slice(0, 1), sourceQuality: sourceQualityNotes.slice(0, 1) };
}

function toneForReadiness(value?: ReadinessCategory): BadgeTone { if (value === 'Release Ready') return 'good'; if (value === 'Needs Work') return 'warn'; if (value === 'Problem Area') return 'bad'; return 'info'; }
function toneForSourceQuality(value?: SourceQualityCategory): BadgeTone {
  if (value === 'Professional Studio Source') return 'good';
  if (value === 'Good Production Source') return 'info';
  if (value === 'Standard Compressed Audio') return 'warn';
  if (value === 'Low Fidelity Source') return 'bad';
  return 'info';
}

function isExtremeBalance(low?: number | null, mid?: number | null, high?: number | null): boolean {
  if (typeof low !== 'number' || typeof mid !== 'number' || typeof high !== 'number') return false;
  return low < 12 || high < 10 || low > 55 || high > 45 || mid > 74;
}

function assessSourceQuality(result: AnalysisResult | null, fileName: string): SourceQualityAssessment | null {
  if (!result) return null;
  const context = getSourceContext(result, fileName);
  const isWav = context.isWav;
  const isCompressed = context.isCompressed;
  const channels = result.channels ?? 0;
  const stereo = channels >= 2;
  const clippingCount = result.clippingCount ?? 0;
  const peak = result.peakDb;
  const lufs = result.lufsEstimate ?? result.lufs;
  const safeHeadroom = typeof peak === 'number' && peak <= -6;
  const extremeBalance = isExtremeBalance(result.lowPercent, result.midPercent, result.highPercent);
  const mutedHighs = typeof result.highPercent === 'number' && result.highPercent < 14;
  const lowLoudness = typeof lufs === 'number' && lufs < -16;
  const weakSignal = typeof result.rmsDb === 'number' && result.rmsDb < -21;
  const boomyLowEnd = typeof result.lowPercent === 'number' && result.lowPercent > 46;
  const strongSignal = typeof result.rmsDb === 'number' && result.rmsDb > -16;
  const balancedTone = !extremeBalance && !mutedHighs && !boomyLowEnd;
  const stemContext = context.isLikelyStem || context.isVocalStem || context.isInstrumentStem;
  const releaseReadyScore = (result.score ?? 0) >= 85 && (result.readiness === 'Release Ready' || (lufs !== null && typeof lufs === 'number' && lufs >= -14.5));
  const sourceTypeGuess = `${isWav ? 'WAV' : isCompressed ? 'MP3/compressed' : 'Unknown'}${typeof result.sampleRate === 'number' ? `, ${result.sampleRate} Hz` : ''}${channels ? `, ${channels === 1 ? 'mono' : 'stereo'}` : ''}`;

  if (isWav && stereo && clippingCount === 0 && balancedTone && typeof peak === 'number' && peak <= -1.2 && releaseReadyScore) {
    return {
      rating: 'Professional Studio Source',
      confidence: 94,
      masteringReadiness: 'Release Ready',
      sourceTypeGuess,
      note: 'This appears close to a finished master.',
      notMasteredYet: false
    };
  }

  if (isWav && clippingCount === 0 && safeHeadroom && lowLoudness && balancedTone) {
    return {
      rating: 'Professional Studio Source',
      confidence: 92,
      masteringReadiness: 'Not Mastered',
      sourceTypeGuess,
      note: 'Professional raw source detected. File appears intentionally unmastered.',
      notMasteredYet: true
    };
  }

  if (isWav && (clippingCount > 0 || ((channels === 1 && !lowLoudness) && !stemContext) || boomyLowEnd || (!stemContext && weakSignal) || extremeBalance)) {
    return {
      rating: clippingCount > 2 || weakSignal ? 'Low Fidelity Source' : 'Good Production Source',
      confidence: 78,
      masteringReadiness: clippingCount > 2 ? 'Not Recommended' : 'Needs Work',
      sourceTypeGuess,
      note: stemContext ? 'This source appears to be a raw isolated track rather than a finished master.' : 'This is a WAV file, but the audio itself still has quality issues.',
      notMasteredYet: lowLoudness && clippingCount === 0 && safeHeadroom
    };
  }

  if (isWav && stereo && clippingCount === 0 && balancedTone) {
    return {
      rating: 'Professional Studio Source',
      confidence: 86,
      masteringReadiness: lowLoudness ? 'Not Mastered' : 'Needs Work',
      sourceTypeGuess,
      note: lowLoudness ? 'Professional studio exports are often quieter before mastering.' : 'Clean WAV source suitable for polishing.',
      notMasteredYet: lowLoudness && safeHeadroom
    };
  }

  if (isCompressed && (mutedHighs || clippingCount > 0 || weakSignal || boomyLowEnd || extremeBalance)) {
    return {
      rating: 'Low Fidelity Source',
      confidence: 84,
      masteringReadiness: 'Not Recommended',
      sourceTypeGuess,
      note: 'Compressed source with issues. Clean up artifacts, rumble, or harshness before mastering.',
      notMasteredYet: lowLoudness && safeHeadroom
    };
  }

  if (isCompressed && stereo && clippingCount === 0 && balancedTone && strongSignal) {
    return {
      rating: 'Good Production Source',
      confidence: 80,
      masteringReadiness: 'Needs Work',
      sourceTypeGuess,
      note: 'Strong compressed source. Suitable for basic mastering checks.',
      notMasteredYet: false
    };
  }

  if (isCompressed) {
    return {
      rating: 'Standard Compressed Audio',
      confidence: 74,
      masteringReadiness: 'Needs Work',
      sourceTypeGuess,
      note: 'Usable compressed source. Good for beginner release prep, but may have MP3 limits.',
      notMasteredYet: lowLoudness && safeHeadroom
    };
  }

  return {
    rating: clippingCount > 4 || extremeBalance ? 'Low Fidelity Source' : 'Good Production Source',
    confidence: 68,
    masteringReadiness: clippingCount > 4 ? 'Not Recommended' : 'Needs Work',
    sourceTypeGuess,
    note: clippingCount > 4 ? 'Source has quality issues that should be fixed before mastering.' : 'Clean source with usable balance, but verify mastering readiness separately.',
    notMasteredYet: false
  };
}

function buildPlainEnglishSummary(result: AnalysisResult, sourceQuality: SourceQualityAssessment | null): { hearing: string[]; why: string[]; next: string[]; healthy: boolean } {
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
  if (sourceQuality) {
    hearing.push(`Source quality looks like: ${sourceQuality.rating}.`);
    why.push(sourceQuality.note);
  }

  if (typeof lufs === 'number' && lufs < -16) {
    hearing.push('The track sounds quiet compared with most modern releases.');
    why.push('Overall loudness is lower than common streaming targets.');
    next.push('Turn the track up slowly, then check it still sounds clean.');
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
    next.push('Add a little warmth if the track feels thin, but keep it subtle.');
  }
  if (typeof low === 'number' && low > 44) {
    hearing.push('The bass feels heavy and can get boomy.');
    why.push('Too much spectral energy is concentrated in the low frequencies.');
    next.push('Reduce muddy low frequencies with subtractive EQ and tighten the low-end dynamics.');
  }
  if (typeof peak === 'number' && peak > -1) {
    hearing.push('The loudest moments are very close to distortion.');
    why.push('Peak level is above the safer mastering headroom target.');
    next.push('Set your limiter/output so the loudest parts stay below -1 dB.');
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
  const [listeningCoachingModeEnabled, setListeningCoachingModeEnabled] = useState(true);
  const [seekToSec, setSeekToSec] = useState<number | null>(null);
  const [appMode, setAppMode] = useState<AppMode>('beginner');
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
  const sourceQuality = useMemo(() => assessSourceQuality(result, fileName), [result, fileName]);
  const plainEnglishSummary = result ? buildPlainEnglishSummary(result, sourceQuality) : null;
  const autoFixPlan = result ? buildAutoFixPlan(result, sourceQuality) : null;

  const listeningCoach = autoFixPlan ? {
    quickSummary: autoFixPlan.wrong.slice(0, 3),
    whatMatters: autoFixPlan.matters,
    whatToDoFirst: autoFixPlan.first,
    whatToListenFor: autoFixPlan.listenFor,
    whatNotToDo: autoFixPlan.avoid.slice(0, 3),
    coachNote: autoFixPlan.readiness[0] ?? 'Keep refining with small, intentional moves and re-check after each change.'
  } : null;
  const runSafeModeAutoFix = useCallback(() => {
    setSafeModeFixPlan(buildSafeModeFixPlan(result));
  }, [result]);
  const priorityFix = useMemo(() => getPriorityFix(result), [result]);

  const listeningCoachingMode: ListeningCoachingMode | null = useMemo(() => {
    if (!result || !listeningCoachingModeEnabled) return null;
    const feedback: string[] = [];
    const lufs = result.lufsEstimate ?? result.lufs;
    const peak = result.peakDb;
    const low = result.lowPercent;
    const mid = result.midPercent;
    const high = result.highPercent;

    if (typeof peak === 'number') {
      feedback.push(peak > -1
        ? `Your loudest hit is at ${peak.toFixed(1)} dBFS, so let’s pull that down first to keep playback clean.`
        : `Great start: your peak is ${peak.toFixed(1)} dBFS, which is in a safe zone.`);
    }
    if (typeof lufs === 'number') {
      feedback.push(lufs < -16
        ? `Your song is currently around ${lufs.toFixed(1)} LUFS, so a small lift will help it sit better next to other releases.`
        : lufs > -10
          ? `You are around ${lufs.toFixed(1)} LUFS already, so avoid pushing harder and protect your punch.`
          : `Nice loudness zone at about ${lufs.toFixed(1)} LUFS. Focus on feel, not more level.`);
    }
    if (typeof low === 'number' && typeof mid === 'number' && typeof high === 'number') {
      if (low < 22) feedback.push(`Tone check: low end is light (${low.toFixed(0)}%), so add a touch of warmth only after level is stable.`);
      else if (low > 44) feedback.push(`Tone check: lows are heavy (${low.toFixed(0)}%), so trim mud for clearer vocals and tighter kick.`);
      else feedback.push(`Tone check: low/mid/high balance (${low.toFixed(0)}/${mid.toFixed(0)}/${high.toFixed(0)}%) looks healthy overall.`);
    }

    return {
      modeName: 'Listening Coaching Mode',
      intro: 'Friendly, step-by-step mastering help based on what your track is doing right now.',
      dynamicFeedback: feedback,
      fixOrder: [
        'Step 1: Fix peaks — make sure the loudest moments stay clean and controlled.',
        'Step 2: Adjust loudness — bring volume up (or down) in small moves while keeping transients natural.',
        'Step 3: Adjust tone — shape bass/mids/highs last, once level decisions are done.'
      ]
    };
  }, [result, listeningCoachingModeEnabled]);
  const soundProfile = buildSoundProfile(result, fileName);
  const whyItSoundsThisWay = buildWhyItSoundsThisWay(result);
  const fixSuggestions = buildFixSuggestions(result);
  const audioType = detectAudioType(result, fileName);
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
    'Thin low-end → Add subtle warmth': {
      title: 'Lacks bass / thin sound',
      explanation: 'Bass and warmth are weak here.',
      fix: 'Add a little warmth if the track feels thin, but keep it subtle.',
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
  const isBeginnerMode = appMode === 'beginner';
  const isCreatorMode = appMode === 'creator';


  return (
    <main className="app-shell">
      <section className="card compact">
        <header className="topbar"><div><div className="brand-row"><span className="brand-icon" aria-hidden="true"><svg viewBox="0 0 64 64" role="img"><path d="M12 38V31C12 19.4 21.4 10 33 10s21 9.4 21 21v7" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round"/><rect x="9" y="33" width="11" height="20" rx="5" fill="currentColor"/><rect x="46" y="33" width="11" height="20" rx="5" fill="currentColor"/></svg></span><h1>Studio Sense</h1></div><p className="subhead">Interactive listening + section mastering check</p><p className="subhead">Your beginner listening coach for understanding and improving music quality.</p></div><label className="upload-btn" htmlFor="audio-upload">{isAnalyzing ? 'Analyzing…' : 'Upload audio'}</label><input id="audio-upload" type="file" accept="audio/*" onChange={onFileChange} disabled={loading} /></header>
  <section className="mode-toggle-wrap" aria-label="Mode switch">
    <span className="mode-toggle-label">View mode</span>
    <div className="mode-toggle" role="tablist" aria-label="Beginner and creator mode">
      <button type="button" role="tab" aria-selected={isBeginnerMode} className={`mode-toggle-btn ${isBeginnerMode ? 'active' : ''}`} onClick={() => setAppMode('beginner')}>Beginner Mode</button>
      <button type="button" role="tab" aria-selected={isCreatorMode} className={`mode-toggle-btn ${isCreatorMode ? 'active' : ''}`} onClick={() => setAppMode('creator')}>Creator Mode</button>
    </div>
  </section>
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
  <section className="sound-profile-card"><h2>SOURCE QUALITY</h2><p><strong>Source Quality:</strong> <span className={`pill ${toneForSourceQuality(sourceQuality?.rating)}`}>{sourceQuality?.rating ?? '—'}</span></p><p><strong>Confidence:</strong> {typeof sourceQuality?.confidence === 'number' ? `${sourceQuality.confidence}%` : '—'}</p><p><strong>Mastering Readiness:</strong> <span className={`pill ${toneForReadiness(result?.readiness)}`}>{sourceQuality?.masteringReadiness ?? '—'}</span></p><p><strong>Source type guess:</strong> {sourceQuality?.sourceTypeGuess ?? 'Run analysis to detect source type.'}</p><p><strong>Coach note:</strong> {isCreatorMode && result ? `${sourceQuality?.sourceTypeGuess ?? ''}${typeof result.peakDb === 'number' ? `, peak ${result.peakDb.toFixed(1)} dBFS` : ''}${typeof result.lufsEstimate === 'number' ? `, LUFS ${result.lufsEstimate.toFixed(1)}.` : '.'} ${sourceQuality?.note ?? ''}` : sourceQuality?.note ?? 'Run analysis for source guidance.'}</p><p><em>Mastering readiness is different from source quality. Professional studio exports are often quieter before mastering. Raw WAV files may sound less exciting before final mastering.</em></p></section>
  <section className="sound-profile-card"><h2>📼 Audio Type</h2><p>{audioType}</p></section>
  <section className="guidance"><h2>🧠 Why it sounds like this</h2><ul>{whyItSoundsThisWay.map((reason) => <li key={reason}>{reason}</li>)}</ul></section>
  <section className="guidance"><h2>🛠 How to fix it</h2>{fixSuggestions.length ? <ul>{fixSuggestions.map((fix) => <li key={fix}>{fix}</li>)}</ul> : <p>Looks healthy. Use minor polish and final reference checks.</p>}</section>


  <ListeningCoach lufs={result?.lufsEstimate ?? result?.lufs} peak={result?.peakDb} balance={{ low: result?.lowPercent ?? 0, high: result?.highPercent ?? 0 }} /><section className="guidance"><h2>🎧 Listening Coach</h2>{listeningCoach ? <><h3>🎧 Quick Summary</h3><ul>{listeningCoach.quickSummary.map((item) => <li key={`coach-quick-${item}`}>{item}</li>)}</ul><h3>⚠️ What Matters</h3><ul>{listeningCoach.whatMatters.map((item) => <li key={`coach-matters-${item}`}>{item}</li>)}</ul><h3>🛠️ What To Do First</h3><ol>{listeningCoach.whatToDoFirst.map((item) => <li key={`coach-first-${item}`}>{item}</li>)}</ol><h3>🎧 What to listen for</h3><ul>{listeningCoach.whatToListenFor.map((item) => <li key={`coach-listen-${item}`}>{item}</li>)}</ul><h3>🚫 What NOT To Do</h3><ul>{listeningCoach.whatNotToDo.map((item) => <li key={`coach-avoid-${item}`}>{item}</li>)}</ul><h3>🎯 Coach Note</h3><p>{listeningCoach.coachNote}</p></> : <p className="empty">Run analysis to unlock your beginner-friendly Listening Coach plan.</p>}</section>
  <section className="guidance"><h2>🟦 Listening Coach: Listening Coaching Mode</h2><div className="workflow-row"><button className="upload-btn" type="button" onClick={() => setListeningCoachingModeEnabled((v) => !v)}>{listeningCoachingModeEnabled ? 'Mode: On' : 'Mode: Off'}</button></div>{listeningCoachingMode ? <><p>{listeningCoachingMode.intro}</p><h3>Dynamic feedback</h3><ul>{listeningCoachingMode.dynamicFeedback.map((item) => <li key={`dynamic-${item}`}>{item}</li>)}</ul><h3>Fix Order</h3><ol>{listeningCoachingMode.fixOrder.map((step) => <li key={step}>{step}</li>)}</ol></> : <p className="empty">Turn on Listening Coaching Mode and run analysis to get guided feedback.</p>}</section>
  {isCreatorMode ? <section className="verdicts"><h2>Whole Track Analysis</h2>{verdictItems.length > 0 ? <ul>{verdictItems.map((item) => <li key={item.label}><span className={`pill ${item.tone}`}>{item.label}</span><span>{item.text}</span></li>)}</ul> : <p className="empty">Upload a track to see verdicts.</p>}</section> : null}

  {isCreatorMode ? <section className="verdicts problem-timeline"><h2>Markers (enhanced)</h2>{hasAnalyzedTrack ? <>{combinedProblemMarkers.length ? <><ul>{combinedProblemMarkers.map((m) => { const guidance = markerGuidance[m.label] ?? { title: m.label, explanation: m.explanation, fix: 'Review this section and compare against a reference track.', badgeTone: 'warn' as const }; return <li key={m.id} className="timeline-item"><div className="timeline-title-row"><span className={`pill ${guidance.badgeTone}`}>{guidance.title}</span><strong>{formatClock(m.timeSec)}</strong></div><span>{`${m.label} → ${guidance.fix}`}</span><span>{guidance.explanation}</span><button className="jump-btn" type="button" onClick={() => setSeekToSec(m.timeSec)}>Jump</button></li>; })}</ul></> : <p className="empty">✅ No major problem sections detected. Your track is close to release-ready.</p>}</> : <p className="empty">Upload a track to generate problem markers.</p>}</section> : null}

  {isCreatorMode ? <section className="guidance"><h2>Section selection</h2><div className="workflow-row"><button className="upload-btn" type="button" onClick={() => setStartSec(currentTime)} disabled={!audioBuffer}>Mark start</button><button className="upload-btn" type="button" onClick={() => setEndSec(currentTime)} disabled={!audioBuffer}>Mark end</button><button className="upload-btn" type="button" onClick={() => { setStartSec(null); setEndSec(null); setSectionResult(null); }} disabled={!audioBuffer}>Clear section</button></div>
    <div className="metrics-grid"><div className="metric"><span>Start</span><strong>{formatClock(startSec)}</strong></div><div className="metric"><span>End</span><strong>{formatClock(endSec)}</strong></div><div className="metric"><span>Length</span><strong>{hasSelection ? formatClock((endSec ?? 0) - (startSec ?? 0)) : '00:00'}</strong></div><div className="metric"><span>Manual (sec)</span><strong><input className="time-input" type="number" min={0} max={duration} value={startSec ?? 0} onChange={(e) => setStartSec(Number(e.target.value))} /> <input className="time-input" type="number" min={0} max={duration} value={endSec ?? 0} onChange={(e) => setEndSec(Number(e.target.value))} /></strong></div></div>
    <div className="workflow-row"><button className="upload-btn" type="button" disabled={loading || !audioBuffer || !hasSelection} onClick={analyzeSelectedSection}>Analyze selected section</button></div>
  </section> : null}

  {isCreatorMode ? <section className="metrics-grid">
    <div className="metric"><span>Source Quality</span><strong><span className={`pill ${toneForSourceQuality(sourceQuality?.rating)}`}>{sourceQuality?.rating ?? '—'}</span></strong></div><div className="metric"><span>Release Readiness</span><strong><span className={`pill ${toneForReadiness(result?.readiness)}`}>{result?.readiness ?? '—'}</span></strong></div><div className="metric"><span>Score</span><strong>{formatScore(result?.score)}</strong></div><div className="metric"><span>LUFS estimate</span><strong>{formatDb(result?.lufsEstimate)}</strong></div><div className="metric"><span>Peak dBFS</span><strong>{formatDb(result?.peakDb)}</strong></div><div className="metric"><span>RMS dB</span><strong>{formatDb(result?.rmsDb)}</strong></div><div className="metric"><span>Clipping count</span><strong>{formatNumber(result?.clippingCount, 0)}</strong></div><div className="metric"><span>Duration (s)</span><strong>{formatNumber(result?.durationSec, 2)}</strong></div><div className="metric"><span>Sample rate</span><strong>{formatNumber(result?.sampleRate, 0)}</strong></div><div className="metric"><span>Channels</span><strong>{formatNumber(result?.channels, 0)}</strong></div><div className="metric span-2"><span>Low / Mid / High balance (rough)</span><strong>{formatNumber(result?.lowPercent, 0)} / {formatNumber(result?.midPercent, 0)} / {formatNumber(result?.highPercent, 0)}%</strong></div><div className="metric span-2"><span>Source type guess</span><strong>{sourceQuality?.sourceTypeGuess ?? 'Run analysis to classify source type.'}</strong></div><div className="metric span-2"><span>Source quality note</span><strong>{sourceQuality?.note ?? 'Run analysis to classify source quality.'}</strong></div>
  </section> : null}

  {isCreatorMode ? <section className="guidance"><h2>Selected Section Analysis</h2><p className="empty">Browser-based estimate only.</p>{sectionResult ? <><section className="metrics-grid"><div className="metric"><span>Readiness</span><strong><span className={`pill ${toneForReadiness(sectionResult.readiness)}`}>{sectionResult.readiness ?? '—'}</span></strong></div><div className="metric"><span>Score</span><strong>{formatScore(sectionResult.score)}</strong></div><div className="metric"><span>LUFS estimate</span><strong>{formatDb(sectionResult.lufsEstimate)}</strong></div><div className="metric"><span>Peak dBFS</span><strong>{formatDb(sectionResult.peakDb)}</strong></div><div className="metric"><span>RMS dB</span><strong>{formatDb(sectionResult.rmsDb)}</strong></div><div className="metric"><span>Clipping count</span><strong>{formatNumber(sectionResult.clippingCount, 0)}</strong></div><div className="metric span-2"><span>Low / Mid / High rough balance</span><strong>{formatNumber(sectionResult.lowPercent, 0)} / {formatNumber(sectionResult.midPercent, 0)} / {formatNumber(sectionResult.highPercent, 0)}%</strong></div></section>{sectionNarrative.map((n) => <p key={n}>{n}</p>)}<div className="verdicts section-verdicts"><ul>{[{ label: 'Loudness verdict', text: sectionResult.loudnessVerdict }, { label: 'Peak safety verdict', text: sectionResult.peakSafetyVerdict }, { label: 'Clipping warning', text: sectionResult.clippingVerdict }, { label: 'Low/Mid/High verdict', text: sectionResult.balanceVerdict }, { label: 'Mastering suggestion', text: sectionResult.masteringSuggestion }].filter((item) => Boolean(item.text)).map((item) => <li key={item.label}><span className="pill info">{item.label}</span><span>{item.text}</span></li>)}</ul></div><div className="workflow-row"><input className="note-input" value={problemNote} placeholder="Short problem note" onChange={(e) => setProblemNote(e.target.value)} /><button className="upload-btn" type="button" onClick={() => { if (!hasSelection || !sectionResult) return; setManualProblemAreas((prev) => [{ id: `${Date.now()}`, startSec: startSec ?? 0, endSec: endSec ?? 0, note: problemNote || 'Marked problem area', metrics: sectionResult }, ...prev]); setProblemNote(''); }}>Mark as problem area</button></div></> : <p className="empty">Select a valid start/end range, then analyze selected section.</p>}</section> : null}

  <ReleaseChecklist result={result} autoMarkerCount={autoMarkers.length} />


  {isBeginnerMode ? <section className="guidance priority-fix"><h2>🎧 Listening Coach — What to Fix First</h2>{priorityFix ? <><h3>{priorityFix.title}</h3><p>{priorityFix.message}</p></> : <p className="empty">Run analysis to see your highest-priority fix.</p>}</section> : null}<section className="guidance"><h2>Plain English Summary</h2>{plainEnglishSummary ? <><h3>What you're hearing</h3><ul>{plainEnglishSummary.hearing.map((item) => <li key={`hear-${item}`}>{item}</li>)}</ul><h3>Why it’s happening</h3><ul>{plainEnglishSummary.why.map((item) => <li key={`why-${item}`}>{item}</li>)}</ul><h3>What to do next</h3><ol>{plainEnglishSummary.next.map((item) => <li key={`next-${item}`}>{item}</li>)}</ol></> : <p className="empty">Run analysis to see a beginner-friendly summary.</p>}</section>

  <section className="guidance"><h2>Fix Your Track — Step by Step</h2>{result ? <><p className="empty">Your Listening Coach recommends this order so each move helps the next one.</p><ol><li>{((result.clippingCount ?? 0) > 0 || (typeof result.peakDb === 'number' && result.peakDb >= -1)) ? 'Fix peaks first before chasing loudness.' : 'Fix clipping and peaks first so your loudest moments stay clean.'}</li><li>Then adjust loudness in small moves so it feels competitive without sounding crushed.</li><li>Then rebalance low-end or high-end only if the tone still feels off.</li><li>Then re-check against a reference track and confirm it translates well.</li></ol></> : <p className="empty">Run analysis to get your Listening Coach step-by-step repair order.</p>}</section>

  <section className="guidance"><h2>Auto Fix Plan</h2>{autoFixPlan ? <><h3>1) What is wrong</h3><ul>{autoFixPlan.wrong.map((item) => <li key={`wrong-${item}`}>{item}</li>)}</ul><h3>2) Why it matters</h3><ul>{autoFixPlan.matters.map((item) => <li key={`matters-${item}`}>{item}</li>)}</ul><h3>3) What to try first</h3><ol>{autoFixPlan.first.map((item) => <li key={`first-${item}`}>{item}</li>)}</ol><h3>4) What to listen for</h3><ul>{autoFixPlan.listenFor.map((item) => <li key={`listen-${item}`}>{item}</li>)}</ul><h3>5) What NOT to do</h3><ul>{autoFixPlan.avoid.map((item) => <li key={`avoid-${item}`}>{item}</li>)}</ul><h3>6) Source quality</h3><ul>{autoFixPlan.sourceQuality.map((item) => <li key={`source-${item}`}>{item}</li>)}</ul><h3>7) Release Readiness</h3><ul>{autoFixPlan.readiness.map((item) => <li key={`ready-${item}`}>{item}</li>)}</ul><h3>🎧 Listening Coach Tip</h3><p>Fix the loudest peaks first.</p><p>Then bring the overall volume up slowly.</p><p>Only adjust tone after that if something still feels off.</p><p>Make small changes and listen each time.</p><p>You don’t need to get it perfect.</p><p>If it sounds better than before, you’re improving.</p></> : <p className="empty">Run analysis to generate a beginner-friendly repair plan.</p>}</section>

  {isCreatorMode ? <section className="guidance"><h2>Target guidance</h2><p>Target LUFS: {TARGET_LUFS}. Safe peak target: below {SAFE_PEAK_DBFS} dBFS.</p><p>Browser-based estimate (including LUFS estimate), not a replacement for studio metering.</p></section> : null}

  <section className="guidance"><h2>Listening Coach Plan</h2><div className="workflow-row"><button className="upload-btn" type="button" onClick={runSafeModeAutoFix} disabled={!result}>Build Listening Coach Plan</button></div>{safeModeFixPlan ? <><h3>🎧 Quick Coach Summary</h3>{safeModeFixPlan.quickSummary.length ? <ul>{safeModeFixPlan.quickSummary.map((item) => <li key={`quick-${item}`}>{item}</li>)}</ul> : <p>• No major red flags detected.</p>}<p><strong>{safeModeFixPlan.startWith}</strong></p><h3>Issue Priority</h3><ul>{safeModeFixPlan.issueSeverity.map((item) => <li key={`severity-${item.label}`}><span className={`pill ${item.severity === 'critical' ? 'bad' : item.severity === 'important' ? 'warn' : 'good'}`}>{item.severity === 'critical' ? '🔴 Critical' : item.severity === 'important' ? '🟠 Important' : '🟢 Optional'}</span> <span>{item.label}</span></li>)}</ul><h3>🎧 WHAT I HEAR</h3><ul>{safeModeFixPlan.whatIHear.map((item) => <li key={`hear-${item}`}>{item}</li>)}</ul><h3>⚠️ WHAT MATTERS</h3><ul>{safeModeFixPlan.whatMatters.map((item) => <li key={`matters-${item}`}>{item}</li>)}</ul><h3>🛠️ WHAT TO DO FIRST</h3><ol>{safeModeFixPlan.whatToDoFirst.map((item) => <li key={`first-${item}`}>{item}</li>)}</ol><h3>🎧 WHAT TO LISTEN FOR</h3><ul><li>Does it feel as loud as other songs?</li><li>Does the bass feel full but not heavy?</li><li>Do vocals/instruments stay clear?</li><li>Do loud parts stay clean without crunch or distortion?</li></ul><h3>🚫 WHAT NOT TO DO</h3><ul>{safeModeFixPlan.whatNotToDo.map((item) => <li key={`avoid-${item}`}>{item}</li>)}</ul><h3>🎯 COACH NOTE</h3><p>{safeModeFixPlan.coachNote}</p></> : <p className="empty">Run analysis, then tap “Build Listening Coach Plan” for a structured listening coach plan.</p>}</section>
      </section>
    </main>
  );
}
