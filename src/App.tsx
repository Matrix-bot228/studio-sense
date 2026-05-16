import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import AudioPlayer from './AudioPlayer';
import ReleaseChecklist from './ReleaseChecklist';
import ListeningCoach from './ListeningCoach';

type ReadinessCategory = 'Release Ready' | 'Needs Work' | 'Problem Area';
type SourceQualityCategory = 'Low Fidelity Source' | 'Standard Compressed Audio' | 'Good Production Source' | 'Professional Studio Source';
type MasteringReadinessCategory = 'Release Ready' | 'Needs Work' | 'Not Mastered' | 'Not Recommended';
type BadgeTone = 'good' | 'warn' | 'bad' | 'info';

type AnalysisResult = {
  bandPercents?: Record<string, number>;
  confidence?: 'High' | 'Medium' | 'Low';
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
type AnalysisDebug = {
  bandEnergy?: Record<string, number>;
  ratios?: Record<string, number>;
  loudness?: Record<string, number>;
  profileDecision?: string;
  finalReason?: string;
  frameCount?: number;
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


type CentralAnalysisState = {
  bassMasking: boolean;
  bassHeavy: boolean;
  muddy: boolean;
  harsh: boolean;
  tooQuiet: boolean;
  loudCompressed: boolean;
  darkTone: boolean;
  brightThin: boolean;
  releaseProblem: boolean;
  majorProblem: boolean;
  releaseReady: boolean;
  profile: string;
  profileInputs: {
    low: number;
    mid: number;
    high: number;
    lufs: number | null;
    clipping: number;
    releaseReady: boolean;
    releaseProblem: boolean;
    majorProblem: boolean;
    bassHeavy: boolean;
    tooQuiet: boolean;
    darkTone: boolean;
    brightThin: boolean;
    loudCompressed: boolean;
    muddy: boolean;
    harsh: boolean;
    problemArea: boolean;
  };
  confidence: 'Low' | 'Medium' | 'High';
  primaryIssue: string;
  mixCharacter: string[];
};

function getCentralAnalysisState(result: AnalysisResult | null): CentralAnalysisState | null {
  if (!result) return null;
  const low = result.lowPercent ?? 0;
  const mid = result.midPercent ?? 0;
  const high = result.highPercent ?? 0;
  const lufs = result.lufs ?? result.lufsEstimate;
  const frequencyIssue = detectFrequencyIssue(result);
  const bassMasking = low > 44;
  const bassHeavy = low > 52;
  const muddy = (mid > 64 && low > 30) || frequencyIssue?.range === '300–800 Hz' || frequencyIssue?.range === '200–400 Hz';
  const harsh = frequencyIssue?.range === '2k–5k' || (high > 40 && mid > 22);
  const tooQuiet = typeof lufs === 'number' && lufs < -16;
  const loudCompressed = (typeof lufs === 'number' && lufs >= -10.5) || (result.clippingCount ?? 0) > 0;
  const darkTone = (high < 14 || frequencyIssue?.range === '8k–12k') && low > 34;
  const brightThin = low < 22 && (high > 26 || frequencyIssue?.range === '2k–5k');
  const releaseProblem = result.readiness === 'Problem Area' || result.readiness === 'Needs Work';
  const problemArea = releaseProblem;
  const majorProblem = bassMasking || bassHeavy || muddy || harsh || tooQuiet || releaseProblem;
  const releaseReady = result.readiness === 'Release Ready' && !majorProblem;
  const clipping = result.clippingCount ?? 0;

  const hasCriticalIssue = bassHeavy || tooQuiet || problemArea || muddy || harsh || clipping > 0;
  let profile = 'Balanced modern master';
  if (hasCriticalIssue) {
    if (bassHeavy && tooQuiet) profile = 'Warm bass-heavy unmastered mix';
    else if (darkTone && tooQuiet) profile = 'Dark low-loudness mix';
    else if (brightThin && loudCompressed) profile = 'Bright compressed master';
    else if (harsh && loudCompressed) profile = 'Aggressive compressed master';
    else if (tooQuiet) profile = darkTone ? 'Dark low-loudness mix' : 'Dynamic unmastered mix';
    else if (muddy || bassMasking || bassHeavy) profile = 'Warm bass-heavy unmastered mix';
    else if (problemArea) profile = 'Problem-area unmastered mix';
  } else if (releaseReady) {
    profile = 'Balanced modern master';
  } else if (darkTone) {
    profile = 'Dynamic vintage-style mix';
  } else if (brightThin) {
    profile = 'Bright modern mix';
  }

  let primaryIssue = 'none detected';
  if (bassHeavy || bassMasking) primaryIssue = 'excessive low-end buildup';
  if (tooQuiet) primaryIssue = 'low streaming loudness';
  if (harsh) primaryIssue = 'harsh upper mids';
  if (muddy) primaryIssue = 'muddy low-mid congestion';
  if (loudCompressed && harsh) primaryIssue = 'compression-driven harshness';

  const mixCharacter: string[] = [];
  if (bassHeavy) mixCharacter.push('Warm');
  if (darkTone) mixCharacter.push('Dark', 'Vintage');
  if (brightThin || harsh) mixCharacter.push('Bright');
  if (!releaseProblem && !tooQuiet) mixCharacter.push('Modern');
  if (loudCompressed) mixCharacter.push('Punchy');
  if (tooQuiet) mixCharacter.push('Soft');
  if ((result.channels ?? 2) >= 2) mixCharacter.push('Wide stereo');
  if ((result.channels ?? 2) === 1) mixCharacter.push('Narrow stereo');
  const uniqueMixCharacter = Array.from(new Set(mixCharacter));

  const confidenceSignals = [
    bassHeavy,
    muddy || bassMasking,
    harsh,
    tooQuiet || loudCompressed,
    darkTone || brightThin,
    typeof lufs === 'number',
    typeof low === 'number' && typeof mid === 'number' && typeof high === 'number'
  ].filter(Boolean).length;
  let confidence: 'Low' | 'Medium' | 'High' = 'Low';
  if (confidenceSignals >= 6) confidence = 'High';
  else if (confidenceSignals >= 4) confidence = 'Medium';

  if (!majorProblem && releaseReady) {
    primaryIssue = 'none detected';
  }
  return {
    bassMasking, bassHeavy, muddy, harsh, tooQuiet, loudCompressed, darkTone, brightThin, releaseProblem, majorProblem, releaseReady, profile, confidence, primaryIssue, mixCharacter: uniqueMixCharacter,
    profileInputs: { low, mid, high, lufs: typeof lufs === 'number' ? lufs : null, clipping, releaseReady, releaseProblem, majorProblem, bassHeavy, tooQuiet, darkTone, brightThin, loudCompressed, muddy, harsh, problemArea }
  };
}

type WorkerAudioData = { channels: Float32Array[]; sampleRate: number; durationSec: number };
type WorkerRequest =
  | { type: 'analyze'; payload: WorkerAudioData }
  | { type: 'analyzeSection'; payload: WorkerAudioData & { startSec: number; endSec: number } };

type WorkerStageMessage = { type: 'stage'; stage: string; requestId: number };
type WorkerDoneMessage = { type: 'done'; result?: AnalysisResult; markers?: ProblemMarker[]; debug?: AnalysisDebug | null; isLargeFile?: boolean; data?: { result: AnalysisResult; markers: ProblemMarker[]; debug?: AnalysisDebug | null }; requestId: number };
type WorkerSectionDoneMessage = { type: 'sectionDone'; sectionResult: AnalysisResult; debug?: AnalysisDebug | null; requestId: number };
type WorkerErrorMessage = { type: 'error'; error?: string; requestId: number };
type WorkerResponseMessage = WorkerStageMessage | WorkerDoneMessage | WorkerSectionDoneMessage | WorkerErrorMessage;

const ANALYSIS_TIMEOUT_MS = 60_000;

type SourceContext = {
  isWav: boolean;
  isCompressed: boolean;
  isMono: boolean;
  stereoWidth: 'Mono' | 'Narrow stereo' | 'Stereo';
  isStemName: boolean;
  isVocalStem: boolean;
  isInstrumentStem: boolean;
  isLikelyStem: boolean;
  isStemKeywordWav: boolean;
  archivalSignalCount: number;
  poorSpectralIndicators: number;
  highFrequencyRolloff: boolean;
  noisyHighs: boolean;
  unstablePeaks: boolean;
  weakRms: boolean;
  archivalIndicators: boolean;
  sourceQuality?: string;
  masteringReadiness?: string;
  sourceTypeGuess?: string;
  isNarrowStereo?: boolean;
  cassetteLikeBalance?: boolean;
  severeRolloff?: boolean;
};

type SoundProfileDebugFlags = {
  isVisibleLowFidelity: boolean;
  isVisibleNotRecommended: boolean;
  isMonoOrNarrow: boolean;
  isOldTapeLike: boolean;
};

function getSourceContext(result: AnalysisResult, fileName: string): SourceContext {
  const normalizedName = fileName.toLowerCase();
  const extension = normalizedName.split('.').pop() ?? '';
  const isWav = extension === 'wav' || extension === 'wave';
  const isCompressed = ['mp3', 'm4a', 'aac', 'ogg'].includes(extension);
  const isMono = (result.channels ?? 0) === 1;
  const stereoWidth: SourceContext['stereoWidth'] = isMono ? 'Mono' : (typeof result.midPercent === 'number' && result.midPercent > 72 ? 'Narrow stereo' : 'Stereo');
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
  return {
    isWav, isCompressed, isMono, stereoWidth, isStemName, isVocalStem, isInstrumentStem,
    isLikelyStem: isWav && isStemName, isStemKeywordWav: isWav && isStemName, archivalSignalCount, poorSpectralIndicators,
    highFrequencyRolloff: severeRolloff, noisyHighs, unstablePeaks, weakRms, archivalIndicators: archivalName || compressedArchival || cassetteLikeBalance,
    sourceQuality: result.sourceQuality?.isLowFidelitySource ? 'Low Fidelity Source' : '',
    masteringReadiness: result.sourceQuality?.isNotRecommended ? 'Not Recommended' : '',
    sourceTypeGuess: result.sourceQuality?.sourceType ?? '',
    isNarrowStereo: stereoWidth === 'Narrow stereo',
    cassetteLikeBalance,
    severeRolloff
  };
}

function getSoundProfileDebugFlags(result: AnalysisResult | null, fileName: string): SoundProfileDebugFlags {
  const context = result ? getSourceContext(result, fileName) : null;
  const isVisibleLowFidelity =
    String(result?.sourceQuality?.isLowFidelitySource ? 'Low Fidelity Source' : "").toLowerCase().includes("low fidelity") ||
    String(context?.sourceQuality ?? "").toLowerCase().includes("low fidelity");
  const isVisibleNotRecommended =
    String(result?.sourceQuality?.isNotRecommended ? 'Not Recommended' : "").toLowerCase().includes("not recommended") ||
    String(context?.masteringReadiness ?? "").toLowerCase().includes("not recommended");
  const isMonoOrNarrow =
    context?.isMono === true ||
    context?.isNarrowStereo === true ||
    String(result?.sourceQuality?.sourceType ?? "").toLowerCase().includes("mono") ||
    String(result?.sourceQuality?.sourceType ?? "").toLowerCase().includes("narrow");
  const isOldTapeLike =
    isVisibleLowFidelity &&
    isVisibleNotRecommended &&
    (
      isMonoOrNarrow ||
      (context?.archivalSignalCount ?? 0) >= 1 ||
      context?.cassetteLikeBalance === true ||
      context?.severeRolloff === true ||
      context?.weakRms === true ||
      context?.unstablePeaks === true
    );
  return { isVisibleLowFidelity, isVisibleNotRecommended, isMonoOrNarrow, isOldTapeLike };
}


function buildSoundProfile(
  analysisState: CentralAnalysisState | null,
  sourceQuality: SourceQualityAssessment | null,
  sourceQualityLabel: string,
  sourceTypeGuess: string,
  userIntent: UserIntent,
  result: AnalysisResult | null,
  displayedAudioType: string,
  fileName = ''
): string {
  if (!analysisState) return 'Analyzing sound profile…';
  const context = result ? getSourceContext(result, fileName) : null;
  const { isVisibleLowFidelity, isMonoOrNarrow, isOldTapeLike } = getSoundProfileDebugFlags(result, fileName);

  if (isVisibleLowFidelity && isMonoOrNarrow) {
    analysisState.primaryIssue = 'mono low-fidelity source';
    analysisState.confidence = 'High';
    analysisState.mixCharacter = Array.from(new Set([...(analysisState.mixCharacter ?? []), 'Mono', 'Vintage', 'Dark', 'Low fidelity']));
    return 'Low-fidelity mono recording';
  }

  if (isOldTapeLike) {
    analysisState.primaryIssue = 'archival recording quality';
    analysisState.confidence = 'High';
    analysisState.mixCharacter = Array.from(new Set([...(analysisState.mixCharacter ?? []), 'Vintage', 'Dark', 'Restoration source']));
    return 'Archival / tape-style restoration source';
  }

  console.log("SoundProfile source debug", {
    sourceQualityLabel,
    sourceQuality,
    sourceTypeGuess,
    sourceType: sourceQuality?.sourceTypeGuess,
  });
  const finalSourceQualityLabel = sourceQuality?.rating ?? sourceQualityLabel ?? '';
  const finalSourceTypeGuess = sourceQuality?.sourceTypeGuess ?? sourceTypeGuess ?? '';
  const sourceQualityText = String(finalSourceQualityLabel).toLowerCase();
  const sourceTypeText = String(finalSourceTypeGuess).toLowerCase();

  if ((/low[ -]?fidelity source/i.test(finalSourceQualityLabel) || /low[ -]?fidelity/i.test(sourceQualityText)) && sourceTypeText.includes("mono")) {
    analysisState.primaryIssue = 'mono low-fidelity source';
    analysisState.confidence = 'High';
    analysisState.mixCharacter = ['Mono', 'Vintage', 'Dark', 'Low fidelity'];
    return 'Low-fidelity mono recording';
  }

  console.log("BUILD SOUND PROFILE DEBUG", {
    hasResult: Boolean(result),
    context,
    isMono: context?.isMono,
    isCompressed: context?.isCompressed,
    archivalSignalCount: context?.archivalSignalCount,
  });

  const { bassHeavy, tooQuiet, darkTone, releaseReady } = analysisState;
  const selectedNotSure = isNotSureIntent(userIntent.description);
  const restorationIntent = userIntent.genre === 'Archival / Restoration' || /(archiv|restor|old recording|transfer|cassette|tape)/i.test(userIntent.description);
  const sourceType = finalSourceTypeGuess;
  const audioTypeLabel = displayedAudioType ?? '';
  const isMonoSource = (result?.channels ?? 2) === 1;
  const isNarrowStereo = /narrow/i.test(sourceType) || ((result?.channels ?? 2) > 1 && (result?.midPercent ?? 0) > 72);
  const isCompressedSource = /mp3\/compressed|compressed/i.test(sourceType);
  const isMonoOrNarrowSource = isMonoSource || /mono/i.test(sourceType) || isNarrowStereo || isMonoOrNarrow;
  const archivalSignalCount = context?.archivalSignalCount ?? 0;
  const sourceQualityRating = finalSourceQualityLabel;
  const isLowFidelitySource =
    Boolean(context?.isMono) ||
    (context?.archivalSignalCount ?? 0) >= 2 ||
    Boolean(context?.isCompressed);
  const isGoodProductionSource = sourceQualityRating === 'Good Production Source';
  const stereoWidth = context?.stereoWidth ?? (isMonoOrNarrowSource ? 'Narrow stereo' : 'Stereo');
  const highFrequencyRolloff = context?.highFrequencyRolloff ?? false;
  const noisyHighs = context?.noisyHighs ?? false;
  const unstablePeaks = context?.unstablePeaks ?? false;
  const weakRms = context?.weakRms ?? false;
  const archivalIndicators = context?.archivalIndicators ?? false;
  const multiplePoorSpectralIndicators = (context?.poorSpectralIndicators ?? 0) >= 2;
  const hasArchivalIndicators = archivalIndicators || highFrequencyRolloff || noisyHighs || unstablePeaks || weakRms || archivalSignalCount >= 3 || restorationIntent;
  const hasSevereQualityProblems = multiplePoorSpectralIndicators || archivalSignalCount >= 3 || (weakRms && unstablePeaks);
  const isProfessionalCompressedSource = isCompressedSource && !isMonoOrNarrowSource && !hasArchivalIndicators && !hasSevereQualityProblems;

  // Hard overrides must run before any tonal/loudness logic.
  if (/mono/i.test(sourceType) && /low fidelity source/i.test(sourceQualityRating)) {
    analysisState.primaryIssue = 'mono low-fidelity source';
    analysisState.confidence = 'High';
    analysisState.mixCharacter = Array.from(new Set([...analysisState.mixCharacter, 'Mono', 'Vintage', 'Dark', 'Low fidelity']));
    console.debug('[Studio Sense] Sound Profile Decision', { sourceQualityLabel: sourceQualityRating, sourceType, audioTypeLabel, finalSoundProfileTitle: 'Low-fidelity mono recording' });
    return 'Low-fidelity mono recording';
  }

  if (/mp3\/compressed/i.test(sourceType) && /streaming\s*\/\s*compressed audio/i.test(audioTypeLabel) && /stereo/i.test(sourceType) && !/mono/i.test(sourceType)) {
    const lowEndHeavy = bassHeavy || ((result?.lowPercent ?? 0) >= 58);
    const finalProfile = lowEndHeavy ? 'Compressed source with low-end buildup' : 'Streaming / compressed audio source';
    analysisState.primaryIssue = lowEndHeavy ? 'streaming-source tonal balance' : 'compression / source format';
    analysisState.confidence = 'Medium';
    analysisState.mixCharacter = Array.from(new Set([...analysisState.mixCharacter, 'Compressed', stereoWidth]));
    console.debug('[Studio Sense] Sound Profile Decision', { sourceQualityLabel: sourceQualityRating, sourceType, audioTypeLabel, stereoWidth, lowEndHeavy, finalSoundProfileTitle: finalProfile });
    return finalProfile;
  }

  if (isLowFidelitySource && isMonoOrNarrowSource) {
    const finalProfile = selectedNotSure ? 'Studio Sense suspects a low-fidelity mono source' : 'Low-fidelity mono recording';
    analysisState.primaryIssue = 'mono low-fidelity source';
    analysisState.confidence = 'High';
    analysisState.mixCharacter = Array.from(new Set([...analysisState.mixCharacter, 'Mono', 'Vintage', 'Dark', 'Low fidelity']));
    console.debug('[Studio Sense] Sound Profile Decision', { sourceQualityLabel: sourceQualityRating, sourceType, isMonoSource, isNarrowStereo, stereoWidth, finalSoundProfileTitle: finalProfile });
    return finalProfile;
  }

  if (isLowFidelitySource && hasArchivalIndicators) {
    const finalProfile = selectedNotSure ? 'Studio Sense suspects an archival / tape-style restoration source' : 'Archival / tape-style restoration source';
    analysisState.primaryIssue = 'archival recording quality';
    analysisState.confidence = 'High';
    analysisState.mixCharacter = Array.from(new Set([...analysisState.mixCharacter, 'Vintage', 'Dark', 'Restoration source', stereoWidth]));
    console.debug('[Studio Sense] Sound Profile Decision', { sourceQualityLabel: sourceQualityRating, sourceType, isMonoSource, isNarrowStereo, stereoWidth, hasArchivalIndicators, finalSoundProfileTitle: finalProfile });
    return finalProfile;
  }

  if (isCompressedSource && !isMonoOrNarrowSource && !hasArchivalIndicators) {
    const lowEndHeavy = bassHeavy || ((result?.lowPercent ?? 0) >= 58);
    const finalProfile = selectedNotSure
      ? (lowEndHeavy ? 'Studio Sense suspects compressed audio with low-end buildup' : 'Studio Sense suspects a streaming / compressed source')
      : (lowEndHeavy ? 'Compressed source with low-end buildup' : 'Streaming / compressed audio source');
    analysisState.primaryIssue = lowEndHeavy ? 'streaming-source tonal balance' : 'compression / source format';
    analysisState.confidence = 'Medium';
    analysisState.mixCharacter = Array.from(new Set([...analysisState.mixCharacter, 'Compressed', darkTone ? 'Vintage' : 'Modern', stereoWidth]));
    console.debug('[Studio Sense] Sound Profile Decision', { sourceQualityLabel: sourceQualityRating, sourceType, isMonoSource, isNarrowStereo, stereoWidth, isProfessionalCompressedSource, finalSoundProfileTitle: finalProfile });
    return finalProfile;
  }

  if (isGoodProductionSource) {
    // fall through to normal mix-title logic for clean WAV/studio-oriented sources
  }

  let finalProfile = selectedNotSure ? `Studio Sense suspects: ${analysisState.profile}` : analysisState.profile;
  if (bassHeavy && tooQuiet) finalProfile = selectedNotSure ? 'Possible low-end heavy unmastered mix' : 'Low-end heavy mix';
  else if (tooQuiet && darkTone) finalProfile = selectedNotSure ? 'Studio Sense suspects a quiet, dark mix needing gain' : 'Quiet dark mix needing gain';
  else if (tooQuiet) finalProfile = selectedNotSure ? 'Studio Sense suspects low loudness before mastering' : 'Dynamic low-loudness master';
  else if (darkTone && !releaseReady) finalProfile = selectedNotSure ? 'Possible warm vintage-style balance' : 'Warm vintage-style balance';
  else if (releaseReady && !analysisState.majorProblem) finalProfile = 'Streaming-ready balanced master';
  else if (bassHeavy) finalProfile = selectedNotSure ? 'Possible low-end buildup' : 'Low-end heavy mix';
  console.debug('[Studio Sense] Sound Profile Decision', { sourceQualityLabel: sourceQualityRating, sourceType, isMonoSource, isNarrowStereo, stereoWidth, highFrequencyRolloff, noisyHighs, unstablePeaks, weakRms, archivalIndicators, finalSoundProfileTitle: finalProfile });
  return finalProfile;
}

function buildWhyItSoundsThisWay(result: AnalysisResult | null, analysisState: CentralAnalysisState | null): string[] {
  if (!result || !analysisState) return ['Analyzing sound profile…'];
  const reasons: string[] = [];
  const lufs = result.lufs ?? result.lufsEstimate;
  const low = result.lowPercent;
  const high = result.highPercent;
  const clipping = result.clippingCount ?? 0;
  const peakDb = result.peakDb;

  if (clipping === 0) reasons.push('No clipping was detected');
  if (typeof peakDb === 'number' && peakDb < SAFE_PEAK_DBFS) reasons.push('peak headroom is safe');
  if (typeof lufs === 'number' && lufs < -16) reasons.push('the track is too quiet for release');
  if (typeof low === 'number' && low > 60) reasons.push('the low-end is dominating the balance');
  if (typeof high === 'number' && high < 5) reasons.push('highs are muted and missing sparkle');

  if (reasons.length >= 4 && clipping === 0 && typeof peakDb === 'number' && peakDb < SAFE_PEAK_DBFS) {
    return ['No clipping was detected and peak headroom is safe, but the track is too quiet for release. The low-end is dominating the balance, which can make the song feel boomy or dull.'];
  }

  if (!reasons.length) return ['Analysis shows no major technical red flags yet.'];
  return [reasons.join(', ') + '.'];
}

function buildFixSuggestions(result: AnalysisResult | null): string[] {
  if (!result) return [];
  const fixes: string[] = [];
  const lufs = result.lufs ?? result.lufsEstimate;
  const low = result.lowPercent;

  if (typeof low === 'number' && low > 60 && typeof lufs === 'number' && lufs < -16) {
    return ['First reduce muddy low-end, then add about 4–5 dB of gentle gain/limiting while keeping the final peak below -1 dBFS.'];
  }
  if (typeof low === 'number' && low > 60) fixes.push('Reduce muddy low-end first before pushing loudness.');
  if (typeof lufs === 'number' && lufs < -16) fixes.push('Increase loudness gently toward release level while keeping peaks below -1 dBFS.');
  if ((result.clippingCount ?? 0) > 0) fixes.push('Reduce limiting and remove clipping before final export.');
  return fixes;
}


function buildTopMasteringSuggestion(result: AnalysisResult | null): string {
  if (!result) return 'Run analysis to get a mastering suggestion.';
  const lufs = result.lufs ?? result.lufsEstimate;
  const low = result.lowPercent;
  if (typeof low === 'number' && low > 60 && typeof lufs === 'number' && lufs < -16) {
    return 'Rebalance the low-end first, then increase loudness carefully before release.';
  }
  return result.masteringSuggestion ?? 'Use small tonal moves, then level-match before final print.';
}

function detectAudioType(result: AnalysisResult | null, fileName: string, analysisState: CentralAnalysisState | null): string {
  if (!result || !analysisState) return 'Analyzing sound profile…';

  const file = fileName.toLowerCase();
  const channels = result.channels ?? 0;
  const rms = result.rmsDb ?? -99;
  const sampleRate = result.sampleRate ?? 0;
  const clipping = result.clippingCount ?? 0;
  const low = result.lowPercent;
  const mid = result.midPercent;
  const high = result.highPercent;

  const isWav = file.endsWith('.wav') || file.endsWith('.wave');
  const isCompressed = file.endsWith('.mp3') || file.endsWith('.m4a') || file.endsWith('.aac');
  const stemWords = [
    'acappella', 'a cappella', 'vocal', 'vox', 'stem', 'raw', 'closemic', 'close mic', 'mic',
    'saxophone', 'guitar', 'bass', 'drums', 'piano', 'rl', 'flh', 'cube'
  ];
  const looksLikeStem = stemWords.some((word) => file.includes(word));
  const spectralBalanced = typeof low === 'number' && typeof mid === 'number' && typeof high === 'number'
    ? high >= 10 && low >= 10 && low <= 60 && mid >= 15
    : true;

  if (isWav && looksLikeStem && channels === 1) return 'Mono studio stem';
  if (isWav && looksLikeStem) return 'Raw studio stem / multitrack source';
  if (isWav && sampleRate >= 44100 && clipping === 0 && rms > -30 && spectralBalanced) return 'Clean WAV source';
  if (isCompressed) return 'Streaming / compressed audio';
  if (channels === 1 && rms < -30 && !looksLikeStem && !isWav) return 'Possible archival or low-level mono source';
  if (channels === 1 && rms < -30 && !looksLikeStem) return 'Possible archival or low-level mono source';
  if (channels === 1) return 'Mono recording';
  if (analysisState.releaseProblem || analysisState.tooQuiet || analysisState.bassHeavy) {
    return 'Unmastered/problematic digital mix';
  }
  if (channels === 2 && rms > -18) return 'Stereo digital recording';

  return 'Standard recording';
}

function detectSourceConfidence(result: AnalysisResult | null, fileName: string): string {
  if (!result) return '—';
  const audioType = detectAudioType(result, fileName, getCentralAnalysisState(result));
  if (audioType === 'Mono studio stem' || audioType === 'Raw studio stem / multitrack source') return '90%';
  if (audioType === 'Streaming / compressed audio') return '80%';
  if (audioType === 'Clean WAV source') return '70%';
  if (audioType === 'Possible archival or low-level mono source') return '60%';
  return '50%';
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
type FrequencyBandStatus = 'green' | 'yellow' | 'red';
type FrequencyBandRow = { label: string; range: string; energy: number; status: FrequencyBandStatus; humanWording: string };
type FrequencyIssue = { range: string; mainIssue: string; listenerFeeling: string; firstSafeFix: string; avoid: string; markerLabel: string };
type IntentGenre = 'Auto / Not sure' | 'Blues' | 'Reggae' | 'Hard Rock' | 'Pop' | 'Hip Hop' | 'EDM' | 'Acoustic' | 'Jazz' | 'Gospel' | 'Lo-fi' | 'Podcast / Voice' | 'Archival / Restoration' | 'AI Music / Suno';
type IntentOutcome = 'Spotify / streaming release' | 'YouTube upload' | 'Demo mix' | 'Improve clarity' | 'Preserve vintage character' | 'Restoration / archival listenability' | 'AI music cleanup' | 'Reference check only';
type UserIntent = { genre: IntentGenre; outcome: IntentOutcome; description: string };
const DEFAULT_USER_INTENT: UserIntent = { genre: 'Auto / Not sure', outcome: 'Spotify / streaming release', description: '' };

function clampPercent(value: number): number { return Math.max(0, Math.min(100, value)); }
function bandStatus(value: number, yellowAt: number, redAt: number): FrequencyBandStatus {
  if (value >= redAt) return 'red';
  if (value >= yellowAt) return 'yellow';
  return 'green';
}

function detectFrequencyIssue(result: AnalysisResult | null): FrequencyIssue | null {
  if (!result) return null;
  const low = result.lowPercent ?? 0;
  const mid = result.midPercent ?? 0;
  const high = result.highPercent ?? 0;
  const subBass = clampPercent(low * 0.52);
  const bass = clampPercent(low * 0.48 + mid * 0.08);
  const cardboard = clampPercent(mid * 0.34 + low * 0.14);
  const muddyMids = clampPercent(mid * 0.52 + low * 0.12);
  const harshness = clampPercent(mid * 0.2 + high * 0.5);
  const sparkle = clampPercent(high * 0.42);
  if (subBass >= 34) return { range: '20–60 Hz', mainIssue: 'sub bass overload / rumble', listenerFeeling: 'Rumble and uncontrolled low-end pressure.', firstSafeFix: 'Gently reduce 20–60 Hz before any loudness increase.', avoid: 'Do not raise overall volume before controlling rumble.', markerLabel: '20–60 Hz rumble overload' };
  if (bass >= 32) return { range: '80–150 Hz', mainIssue: 'boxy bass / speaker strain / muddy warmth', listenerFeeling: 'Bass feels boxy with speaker strain and unpleasant pressure.', firstSafeFix: 'Gently reduce 80–150 Hz before increasing loudness.', avoid: 'Do not boost overall volume before fixing the bass.', markerLabel: '80–150 Hz too strong' };
  if (cardboard >= 35) return { range: '200–400 Hz', mainIssue: 'cardboard / boxy mids', listenerFeeling: 'Mids feel boxed-in and papery.', firstSafeFix: 'Use a small subtractive cut around 200–400 Hz.', avoid: 'Do not add more mids to force clarity.', markerLabel: '200–400 Hz boxy mids' };
  if (muddyMids >= 42) return { range: '300–800 Hz', mainIssue: 'mud / cloudy mids', listenerFeeling: 'Clarity feels masked and cloudy.', firstSafeFix: 'Trim 300–800 Hz slightly and re-check vocal clarity.', avoid: 'Do not add loudness while clarity is masked.', markerLabel: '300–800 Hz muddy mids' };
  if (harshness >= 42) return { range: '2k–5k', mainIssue: 'harshness / ear fatigue', listenerFeeling: 'Upper mids feel sharp and tiring over time.', firstSafeFix: 'Apply a gentle cut in 2k–5k on harsh peaks.', avoid: 'Do not boost presence to chase detail.', markerLabel: '2k–5k harshness' };
  if (sparkle < 14) return { range: '8k–12k', mainIssue: 'dull top end / missing sparkle', listenerFeeling: 'Top end feels closed and less exciting.', firstSafeFix: 'Add a very gentle top lift only after low-mid cleanup.', avoid: 'Do not over-brighten with a big high shelf.', markerLabel: '8k–12k missing sparkle' };
  return null;
}


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



type RecommendationTopic = 'clipping' | 'loudness' | 'monoStereo' | 'noise' | 'tonalBalance';
const RECOMMENDATION_PRIORITY: RecommendationTopic[] = ['clipping', 'loudness', 'monoStereo', 'noise', 'tonalBalance'];

function buildContextAwareRecommendations(result: AnalysisResult) {
  const channels = result.channels ?? 0;
  const isMono = channels === 1;
  const lufs = result.lufsEstimate ?? result.lufs;
  const rms = result.rmsDb;
  const clippingCount = result.clippingCount ?? 0;
  const low = result.lowPercent;
  const mid = result.midPercent;
  const high = result.highPercent;
  const sourceLooksOldOrLowFi = isMono || (typeof rms === 'number' && rms < -21);
  const balancedTone = typeof low === 'number' && typeof mid === 'number' && typeof high === 'number'
    ? low >= 22 && low <= 44 && high >= 18 && mid <= 65
    : false;

  const byTopic: Record<RecommendationTopic, string | null> = {
    clipping: clippingCount > 0 ? 'Fix clipping first: reduce limiter drive or output gain until crackle is gone.' : null,
    loudness: typeof lufs === 'number' && lufs < -16 ? 'Increase average signal strength carefully before heavy limiting.' : null,
    monoStereo: isMono ? 'Preserve mono compatibility unless widening is intentional.' : null,
    noise: sourceLooksOldOrLowFi ? 'Avoid aggressive compression because artifacts will become more obvious.' : null,
    tonalBalance: balancedTone ? null : (typeof low === 'number' && low > 44 ? 'Trim low-end buildup slightly before adding loudness.' : typeof high === 'number' && high < 18 ? 'Add a small amount of top-end clarity only if needed.' : null)
  };

  const confidence = {
    tonalBalance: balancedTone ? 'Spectral balance appears reasonably balanced (medium confidence).' : 'Spectral balance likely needs refinement (medium confidence).'
  };

  const recommendations = RECOMMENDATION_PRIORITY.map((topic) => byTopic[topic]).filter((x): x is string => Boolean(x));
  return { recommendations, confidence, isMono, balancedTone, sourceLooksOldOrLowFi, clippingCount, lufs, rms };
}

function buildAutoFixPlan(result: AnalysisResult, sourceQuality: SourceQualityAssessment | null, analysisState: CentralAnalysisState | null, userIntent: UserIntent): { wrong: string[]; matters: string[]; first: string[]; listenFor: string[]; avoid: string[]; readiness: string[]; sourceQuality: string[] } {
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
  const frequencyIssue = detectFrequencyIssue(result);
  const adaptive = buildContextAwareRecommendations(result);

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
  const bassMaskingClarity = typeof low === 'number' && low > 44;
  if (bassMaskingClarity) {
    wrong.push('There is too much low-end buildup.');
    matters.push('Boomy bass can hide vocals and detail.');
    first.push('Gently reduce muddy lows. Listen for clearer vocals and tighter bass. Stop when the mix feels balanced, not thin.');
  }
  if (adaptive.balancedTone) {
    matters.push(adaptive.confidence.tonalBalance);
  }
  if (frequencyIssue && !adaptive.balancedTone) {
    wrong.push(`Main frequency issue: ${frequencyIssue.range} (${frequencyIssue.mainIssue}).`);
    matters.push(`Listener impact: ${frequencyIssue.listenerFeeling}`);
    first.push(frequencyIssue.firstSafeFix);
    avoid.push(frequencyIssue.avoid);
  }

  if (channels === 1) avoid.push('Preserve mono compatibility unless widening is intentional.');
  if (typeof rms === 'number' && rms < -21) avoid.push('Avoid aggressive compression because artifacts will become more obvious.');
  if (!avoid.length) avoid.push('Do not chase loudness before peak safety and clipping are clean.');
  if (userIntent.outcome === 'Preserve vintage character') avoid.push('Avoid over-cleaning, over-brightening, and over-limiting.');

  const readinessLabel = result.readiness ?? 'Needs Work';
  const scoreText = typeof result.score === 'number' ? `${Math.round(result.score)} / 100` : 'not scored yet';
  if (sourceQuality) sourceQualityNotes.push(`Source quality: ${sourceQuality.rating}. ${sourceQuality.note}`);
  readiness.push(`Current release readiness: ${readinessLabel} (${scoreText}).`);
  if (userIntent.outcome === 'Restoration / archival listenability') readiness.push('This can likely be improved, but modern commercial clarity may not be possible if detail was not captured in the source.');

  if (analysisState?.majorProblem && result.readiness === 'Release Ready') {
    readiness[0] = 'Current release readiness: Needs Work (major tonal/loudness issues detected).';
  }

  const dedupe = (items: string[]) => [...new Set(items.map((x) => x.trim()))];
  const seen = new Set<string>();
  const prioritizedFirst: string[] = [];
  for (const rec of adaptive.recommendations) { if (!seen.has(rec)) { prioritizedFirst.push(rec); seen.add(rec); } }
  for (const step of first) { if (!seen.has(step)) { prioritizedFirst.push(step); seen.add(step); } }
  const description = userIntent.description.toLowerCase();
  const issuePriority = /(bass|low[- ]?end|boomy|muddy|boxed|vocal buried|harsh|bright|quiet|distorted|clipping|mono)/i;
  const prioritizeIssue = issuePriority.test(description);
  const issueHint = /(bass|low[- ]?end|boomy|muddy|boxed|vocal|clarity|harsh|bright|quiet|gain|distort|clip|mono|stereo|120|150|200|350|2k|5k|8k|12k)/i;
  if (prioritizeIssue) {
    prioritizedFirst.sort((a, b) => Number(issueHint.test(b)) - Number(issueHint.test(a)));
  }

  if (!wrong.length) {
    wrong.push('No major issues were detected in the current analysis.');
    matters.push('Your loudness, peaks, and tone look close to release-safe ranges.');
    first.push('Do a quick reference check. Listen for clean peaks, clear vocals, and balanced bass. Stop when it already feels right.');
  }

  return { wrong: dedupe(wrong), matters: dedupe(matters), first: dedupe(prioritizedFirst).slice(0, 4), listenFor: dedupe(listenFor), avoid: dedupe(avoid).slice(0, 3), readiness: dedupe(readiness).slice(0, 1), sourceQuality: dedupe(sourceQualityNotes).slice(0, 1) };
}



type GoalVsFoundSummary = { audioFinding: string; matchResult: string };

function buildGoalVsFoundSummary(result: AnalysisResult | null, userIntent: UserIntent): GoalVsFoundSummary {
  if (!result) return { audioFinding: 'Run analysis to compare your issue with measured audio data.', matchResult: 'Partly confirmed' };
  const d = userIntent.description.toLowerCase();
  const low = result.lowPercent ?? 0;
  const high = result.highPercent ?? 0;
  const mid = result.midPercent ?? 0;
  const lufs = result.lufsEstimate ?? result.lufs;
  if (/(bass|low end|low-end|boomy|rumble|muddy)/i.test(d)) return low > 45 ? { audioFinding: `Low-end is elevated (${low.toFixed(0)}%), matching your bass concern.`, matchResult: 'Confirmed' } : { audioFinding: `Low-end is not dominant (${low.toFixed(0)}%), so another issue may be more important.`, matchResult: 'Not the main issue' };
  if (/(vocal|voice|lyrics|clarity)/i.test(d)) return (low > 40 || high < 16 || mid < 20) ? { audioFinding: `Vocal masking risk: low-end ${low.toFixed(0)}% with limited mid/high support can hide lyrics.`, matchResult: 'Partly confirmed' } : { audioFinding: 'The spectrum does not show strong vocal masking as the top priority.', matchResult: 'Not the main issue' };
  if (/(quiet|loud|volume|streaming)/i.test(d) && typeof lufs === 'number') return lufs < -14 ? { audioFinding: `Loudness is ${lufs.toFixed(1)} LUFS (about ${Math.abs(-14 - lufs).toFixed(1)} LUFS below -14).`, matchResult: 'Confirmed' } : { audioFinding: `Loudness is ${lufs.toFixed(1)} LUFS and already near common streaming range.`, matchResult: 'Not the main issue' };
  if (/(harsh|sharp|painful|bright)/i.test(d)) return (high > 28) ? { audioFinding: `High/upper-mid energy is elevated (${high.toFixed(0)}%), consistent with harshness.`, matchResult: 'Confirmed' } : { audioFinding: `Highs are not elevated (${high.toFixed(0)}%); harshness may be distortion or source quality related.`, matchResult: 'Partly confirmed' };
  if (isNotSureIntent(userIntent.description)) return { audioFinding: 'You selected Not sure, so Studio Sense looked for the strongest problem.', matchResult: 'Partly confirmed' };
  return { audioFinding: 'Measured audio shows a different main priority than your written issue.', matchResult: 'Partly confirmed' };
}


type SecondOpinion = {
  intro: string;
  soundsOff: string;
  likelyCause: string;
  confidence: string;
  fixFirst: string;
  doNotDo: string;
};

function isNotSureIntent(description: string): boolean {
  const d = description.trim().toLowerCase();
  if (!d.length) return true;
  return /(not sure|unsure|don't know|do not know|no idea|can'?t tell|cant tell|unknown|help me find|figure out)/i.test(d);
}

function buildSecondOpinion(result: AnalysisResult | null, analysisState: CentralAnalysisState | null, priorityFix: { title: string; message: string } | null, userIntent: UserIntent): SecondOpinion {
  if (!result || !analysisState) {
    return {
      intro: 'Run analysis to get your Second Opinion.',
      soundsOff: 'Need audio analysis first.',
      likelyCause: 'Need audio analysis first.',
      confidence: '—',
      fixFirst: 'Upload a track and run analysis.',
      doNotDo: 'Do not make big changes before the analysis.'
    };
  }
  const notSure = isNotSureIntent(userIntent.description);
  const low = result.lowPercent ?? 0;
  const high = result.highPercent ?? 0;
  const lufs = result.lufsEstimate ?? result.lufs;
  const clipping = result.clippingCount ?? 0;

  let hearing = 'Yes — something sounds off.';
  if (analysisState.releaseReady && !analysisState.majorProblem) hearing = 'No major issue detected right now.';

  let likelyCause = 'The strongest issue appears to be tonal balance.';
  if (clipping > 0) likelyCause = `The strongest issue is clipping distortion (${clipping} clipped samples), which can sound crunchy or harsh.`;
  else if (typeof lufs === 'number' && lufs < -16) likelyCause = `The track is likely too quiet (${lufs.toFixed(1)} LUFS), so it may feel weak next to reference songs.`;
  else if (low > 45) likelyCause = `Low-end buildup (${low.toFixed(0)}%) is likely masking clarity, so the mix can feel boomy.`;
  else if (high > 28) likelyCause = `Upper highs are elevated (${high.toFixed(0)}%), which can make the sound feel sharp.`;

  return {
    intro: notSure ? 'You selected Not sure, so Studio Sense looked for the strongest problem.' : 'Studio Sense compared your issue with the measured audio and picked the strongest priority.',
    soundsOff: hearing,
    likelyCause,
    confidence: analysisState.confidence,
    fixFirst: priorityFix?.message ?? 'Start with peak safety and clipping, then re-check loudness and tone.',
    doNotDo: 'Do not stack multiple big EQ/limiter moves at once. Change one thing, then listen again.'
  };
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

  const narrowStereo = /mono|narrow/i.test(sourceTypeGuess);
  const severeRolloff = typeof result.highPercent === 'number' && result.highPercent < 10;
  const noisyHighs = typeof result.highPercent === 'number' && result.highPercent > 45;
  const unstablePeaks = clippingCount > 2;
  const poorCompressedIndicators = [narrowStereo, severeRolloff, noisyHighs, unstablePeaks, weakSignal, context.archivalSignalCount >= 3, context.poorSpectralIndicators >= 2].filter(Boolean).length;

  if (isCompressed && poorCompressedIndicators >= 2) {
    return {
      rating: 'Low Fidelity Source',
      confidence: 84,
      masteringReadiness: 'Not Recommended',
      sourceTypeGuess,
      note: 'Compressed source with issues. Clean up artifacts, rumble, or harshness before mastering.',
      notMasteredYet: lowLoudness && safeHeadroom
    };
  }

  if (isCompressed && stereo && clippingCount === 0 && balancedTone && strongSignal && poorCompressedIndicators <= 1) {
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

function buildPlainEnglishSummary(result: AnalysisResult, sourceQuality: SourceQualityAssessment | null, analysisState: CentralAnalysisState | null, userIntent: UserIntent): { hearing: string[]; why: string[]; next: string[]; healthy: boolean } {
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
  const frequencyIssue = detectFrequencyIssue(result);
  const adaptive = buildContextAwareRecommendations(result);
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
    why.push('Low RMS / low loudness indicates weak signal strength.');
    next.push('Increase average signal strength carefully before heavy limiting.');
  }
  if (isMono) {
    hearing.push('It sounds narrow, like most elements are in the center.');
    why.push('The file appears to be mono or has very limited stereo width.');
    next.push('Preserve mono compatibility unless widening is intentional.');
  }
  if (typeof low === 'number' && low < 22) {
    hearing.push('The low-end feels thin and lacks warmth.');
    why.push('Low frequencies are under-represented compared with mids and highs.');
    next.push('Add a little warmth if the track feels thin, but keep it subtle.');
  }
  const bassMaskingClarity = typeof low === 'number' && low > 44;
  if (bassMaskingClarity) {
    if (userIntent.genre === 'Reggae') {
      hearing.push('Bass presence fits reggae, but check if it masks clarity.');
      why.push('Strong low-end is expected in reggae, but vocal detail can still be masked.');
    } else {
      hearing.push('The bass feels heavy and can get boomy.');
      why.push('Too much spectral energy is concentrated in the low frequencies.');
      next.push('Reduce muddy low frequencies with subtractive EQ and tighten the low-end dynamics.');
    }
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
  if (adaptive.balancedTone) {
    why.push(adaptive.confidence.tonalBalance);
  }
  if (frequencyIssue && !adaptive.balancedTone) {
    hearing.push(`Main frequency issue: ${frequencyIssue.range} feels like ${frequencyIssue.mainIssue}.`);
    why.push(`This creates ${frequencyIssue.listenerFeeling.toLowerCase()}`);
    next.push(frequencyIssue.firstSafeFix);
  }

  const healthy = hearing.length === 0 && !frequencyIssue && !analysisState?.majorProblem;
  if (healthy) {
    hearing.push('The track already sounds balanced and competitive for release.');
    why.push('Loudness, peak headroom, stereo format, and tonal balance are internally consistent.');
    next.push('Do a final reference check, then export your release master.');
  }
  if (sourceQuality?.sourceTypeGuess === 'Compressed source with issues') {
    hearing.push('This sounds like a low-fidelity or older compressed recording.');
    why.push('Weak signal, narrow stereo, rumble, and missing air are common with this kind of source.');
    next.push('Clean the source first before attempting full mastering.');
    next.push('Remove low-end rumble (especially around 20–60 Hz) before adding loudness.');
    next.push('Reduce muddy or harsh bands, then raise gain carefully in small steps.');
    next.push('Avoid heavy limiting so you keep the original character intact.');
    next.push('Aim for clear improvement rather than a modern studio makeover.');
  }

  if (userIntent.genre === 'Blues' || userIntent.genre === 'Jazz') next.push('Preserve warmth and dynamics; avoid over-brightening.');
  if (userIntent.genre === 'Lo-fi') next.push('Focus on whether the lo-fi texture feels pleasant, not perfectly clean.');
  if (userIntent.genre === 'Hard Rock') next.push('Focus on vocal clarity, harsh cymbals, and guitar masking.');
  if (userIntent.genre === 'Archival / Restoration') next.push('Focus on preservation and clarity, not modern polish.');
  if (userIntent.genre === 'AI Music / Suno') next.push('Check for low-end rumble, metallic highs, smeared vocals, fake stereo width, and over-limiting.');

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
  const [analysisDebug, setAnalysisDebug] = useState<AnalysisDebug | null>(null);
  const [status, setStatus] = useState('Tell Studio Sense what you want to achieve, then upload audio.');
  const [analysisStatus, setAnalysisStatus] = useState<'idle' | 'processing' | 'complete' | 'failed'>('idle');
  const [analysisStarted, setAnalysisStarted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [analysisStage, setAnalysisStage] = useState('Idle');
  const [lastAnalysisError, setLastAnalysisError] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [largeFileWarning, setLargeFileWarning] = useState('');
  const [fileName, setFileName] = useState('No file selected');
  const [listeningCoachingModeEnabled, setListeningCoachingModeEnabled] = useState(true);
  const [seekToSec, setSeekToSec] = useState<number | null>(null);
  const [appMode, setAppMode] = useState<AppMode>('beginner');
  const [userIntent, setUserIntent] = useState<UserIntent>(DEFAULT_USER_INTENT);
  const workerRef = useRef<Worker | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
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

  const runWorkerRequest = useCallback((request: WorkerRequest, transfer: Transferable[] = []) => new Promise<WorkerResponseMessage>((resolve, reject) => {
    const worker = workerRef.current;
    if (!worker) {
      reject(new Error('Worker unavailable'));
      return;
    }

    const requestId = ++requestIdRef.current;
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error('Worker request timed out after 60 seconds'));
    }, 60_000);

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
    };

    const handleMessage = (event: MessageEvent<any>) => {
      console.log('Worker message received', event.data);
      if (event.data?.type === 'stage') {
        setAnalysisStage(event.data.stage);
        return;
      }
      if (event.data?.requestId !== undefined && event.data.requestId !== requestId) return;

      if (event.data?.type === 'error' || event.data?.type === 'failed') {
        cleanup();
        reject(new Error(event.data?.error ?? event.data?.message ?? 'Worker failed'));
        return;
      }

      if (event.data?.type === 'done' || event.data?.type === 'sectionDone') {
        if (event.data?.type === 'done' && event.data?.data?.result) {
          cleanup();
          resolve({
            type: 'done',
            result: event.data.data.result,
            markers: event.data.data.markers ?? [],
            debug: event.data.data.debug ?? null,
            isLargeFile: event.data.isLargeFile ?? false,
            requestId
          } as WorkerDoneMessage);
          return;
        }
        cleanup();
        resolve(event.data as WorkerResponseMessage);
        return;
      }

      if (event.data?.result) {
        cleanup();
        resolve({
          type: 'done',
          result: event.data.result,
          markers: event.data.markers ?? [],
          debug: event.data.debug ?? null,
          isLargeFile: event.data.isLargeFile ?? false,
          requestId
        });
      }
    };

    const handleError = () => {
      cleanup();
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
    { label: 'Spectrum verdict', text: result?.balanceVerdict, tone: 'info' as const },
    { label: 'Overall mastering suggestion', text: result?.masteringSuggestion, tone: toneForReadiness(result?.readiness) }
  ].filter((v) => Boolean(v.text)), [result]);

  async function handleFileUpload(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0] ?? null; if (!file) return;
    workerRef.current?.terminate();
    workerRef.current = new Worker(new URL('./workers/audioWorker.ts', import.meta.url), { type: 'module' });
    setLoading(true); setIsAnalyzing(false); setFileName(file.name); setStatus('Loading audio…'); setAnalysisStatus('idle'); setAnalysisStarted(false); setAnalysisStage('Idle'); setLargeFileWarning('');
    setSectionResult(null); setStartSec(null); setEndSec(null); setManualProblemAreas([]); setProblemNote(''); setResult(null); setAutoMarkers([]);
    setAnalysisDebug(null);
    setLastAnalysisError(null);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    const url = URL.createObjectURL(file); setAudioUrl(url);
    setAudioBuffer(null); audioDataRef.current = null;
    setCurrentTime(0);
    setDuration(0);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const audioContext = new AudioContext();
      console.time('StudioSense decode audio');
      const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
      console.timeEnd('StudioSense decode audio');
      await audioContext.close();
      setAudioBuffer(decoded);
      const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => new Float32Array(decoded.getChannelData(i)));
      const workerData = { channels, sampleRate: decoded.sampleRate, durationSec: decoded.duration };
      audioDataRef.current = workerData;
      setDuration(decoded.duration); setCurrentTime(0);
      if (channels[0] && channels[0].length > 44_100 * 60 * 6) setLargeFileWarning('Large file detected — analysis may take longer.');
      setStatus('Audio loaded. Review your goal, then click Analyze with Studio Sense.');
    } catch {
      setResult(null); setAudioBuffer(null); setStatus('Audio ready for playback'); audioDataRef.current = null; setAnalysisDebug(null);
      setAnalysisStatus('idle');
    } finally { setLoading(false); setIsAnalyzing(false); event.target.value = ''; }
  }

  const handleStartAnalysis = useCallback(async () => {
    if (!audioDataRef.current) return;
    console.log('[StudioSense] Analyze button clicked');
    console.time('StudioSense total analyze');
    setAnalysisStarted(true);
    setLoading(true);
    setIsAnalyzing(true);
    setAnalysisStatus('processing');
    setAnalysisStage('Reading audio');
    setStatus('Analyzing…');
    setResult(null);
    setAutoMarkers([]);
    setAnalysisDebug(null);
    try {
      const msg = await Promise.race([
        runWorkerRequest({ type: 'analyze', payload: audioDataRef.current }),
        new Promise<never>((_, reject) => {
          window.setTimeout(() => reject(new Error('Analysis timeout')), ANALYSIS_TIMEOUT_MS);
        })
      ]);
      console.log('Worker message received', msg);
      if (msg.type !== 'done') throw new Error('Invalid worker response');
      const finalResult = msg.result ?? null;
      if (!finalResult) throw new Error('No final analysis result returned');
      console.log('Final analysis result', finalResult);
      setResult(finalResult);
      setAutoMarkers(msg.markers ?? []);
      setAnalysisDebug(msg.debug ?? null);
      setLastAnalysisError(null);
      if (msg.isLargeFile) setLargeFileWarning('Large file detected — analysis may take longer.');
      setAnalysisStatus('complete');
      setAnalysisStage('idle');
      setIsAnalyzing(false);
      setLoading(false);
      setStatus('Analysis complete');
      setAnalysisStarted(true);
      console.timeEnd('StudioSense total analyze');
    } catch (error) {
      console.error('Analysis failed in handleStartAnalysis:', error);
      const message = error instanceof Error ? error.message : String(error);
      setAnalysisStatus('failed');
      setAnalysisStage('idle');
      setStatus(`Analysis failed: ${message}`);
      console.timeEnd('StudioSense total analyze');
    } finally {
      setLoading(false);
      setIsAnalyzing(false);
    }
  }, [runWorkerRequest]);

  const stopCurrentAnalysis = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = new Worker(new URL('./workers/audioWorker.ts', import.meta.url), { type: 'module' });
    requestIdRef.current += 1;
  }, []);

  const handleNewTrack = useCallback(() => {
    stopCurrentAnalysis();
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(null);
    setAudioBuffer(null);
    audioDataRef.current = null;
    setFileName('No file selected');
    setResult(null);
    setAutoMarkers([]);
    setAnalysisDebug(null);
    setLargeFileWarning('');
    setSectionResult(null);
    setStartSec(null);
    setEndSec(null);
    setManualProblemAreas([]);
    setProblemNote('');
    setSeekToSec(null);
    setCurrentTime(0);
    setDuration(0);
    setAnalysisStarted(false);
    setAnalysisStatus('idle');
    setAnalysisStage('Idle');
    setStatus('Ready to upload another track.');
    setLoading(false);
    setIsAnalyzing(false);
    setLastAnalysisError(null);
    setSafeModeFixPlan(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [audioUrl, stopCurrentAnalysis]);


  const analyzeSelectedSection = useCallback(async () => {
    if (!hasSelection || !audioDataRef.current || !workerRef.current) return;
    setLoading(true);
    setIsAnalyzing(true);
    await runWorkerRequest({ type: 'analyzeSection', payload: { ...audioDataRef.current, startSec: startSec ?? 0, endSec: endSec ?? 0 } })
      .then((msg) => {
        if (msg.type === 'sectionDone') setSectionResult(msg.sectionResult);
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
  const analysisState = useMemo(() => getCentralAnalysisState(result), [result]);
  const plainEnglishSummary = result ? buildPlainEnglishSummary(result, sourceQuality, analysisState, userIntent) : null;
  const autoFixPlan = result ? buildAutoFixPlan(result, sourceQuality, analysisState, userIntent) : null;
  const frequencyFeel = result ? detectFrequencyIssue(result) : null;
  const intentAwareCoach = useMemo(() => {
    if (!result) return null;
    const goal = `${userIntent.genre} / ${userIntent.outcome}`;
    return {
      goal,
      matters: userIntent.outcome === 'Spotify / streaming release' ? 'Keep loudness, peak safety, and translation strict for release readiness.' : userIntent.outcome === 'Restoration / archival listenability' ? 'Prioritize preservation and listenability with realistic source limits.' : 'Prioritize clarity and musical translation for your selected outcome.',
      fixFirst: userIntent.genre === 'AI Music / Suno' ? 'Fix artificial low-end buildup, metallic top-end, and smeared vocals first.' : userIntent.genre === 'Archival / Restoration' ? 'Fix intelligibility and reduce distracting artifacts before any loudness push.' : 'Fix peaks/clipping first, then loudness, then tone.',
      avoid: userIntent.outcome === 'Preserve vintage character' ? 'Avoid over-cleaning, over-brightening, and over-limiting.' : userIntent.genre === 'Lo-fi' ? 'Do not remove hiss/softness automatically if the texture is intentional.' : 'Avoid large changes; use small moves and re-check each step.',
      realistic: userIntent.outcome === 'Restoration / archival listenability' ? 'This can likely be improved, but modern commercial clarity may not be possible if detail was not captured in the source.' : userIntent.genre === 'Archival / Restoration' ? 'Aim for clear, stable playback rather than modern polish.' : userIntent.genre === 'AI Music / Suno' ? 'Given your AI music goal, check for artificial low-end buildup, harsh top-end texture, and over-compression before release.' : `Given your ${userIntent.genre.toLowerCase()}/${userIntent.outcome.toLowerCase()} goal, preserve musical intent while improving translation.`
    };
  }, [result, userIntent]);

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
    const rms = result.rmsDb;
    const clippingCount = result.clippingCount ?? 0;
    const low = result.lowPercent;
    const mid = result.midPercent;
    const high = result.highPercent;
    const frequencyIssue = detectFrequencyIssue(result);
    const isMono = (result.channels ?? 2) === 1;
    const isSafePeak = typeof peak === 'number' && peak < SAFE_PEAK_DBFS;
    const poorSource = sourceQuality ? ['Low Fidelity Source', 'Standard Compressed Audio'].includes(sourceQuality.rating) : false;

    if (clippingCount > 0) {
      feedback.push(`Priority 1: clipping was detected (${clippingCount} samples). Back off limiter/output first until crackle is gone.`);
    } else if (typeof peak === 'number') {
      feedback.push(isSafePeak
        ? `Peak is safe at ${peak.toFixed(1)} dBFS, so you do not need clipping repair first.`
        : `Peak is high at ${peak.toFixed(1)} dBFS, so reduce output slightly before pushing level.`);
    }

    if (typeof lufs === 'number') {
      if (lufs < -16 && poorSource) feedback.push(`Loudness is low (${lufs.toFixed(1)} LUFS). Clean the source before pushing loudness.`);
      else if (lufs < -16) feedback.push(`Loudness is low at ${lufs.toFixed(1)} LUFS. Raise level in small steps after peak safety is confirmed.`);
      else if (lufs > -10) feedback.push(`Loudness is already hot at ${lufs.toFixed(1)} LUFS, so avoid extra limiting to keep punch.`);
      else feedback.push(`Loudness is in a usable zone (${lufs.toFixed(1)} LUFS). Focus on translation and tone.`);
    }

    if (typeof rms === 'number') {
      feedback.push(rms < -22 ? `Signal strength is light (${rms.toFixed(1)} dB RMS), so detail may feel distant.` : `Signal strength is solid (${rms.toFixed(1)} dB RMS).`);
    }

    if (typeof low === 'number' && typeof mid === 'number' && typeof high === 'number') {
      if (low > 44) feedback.push(`Low-end buildup: lows are ${low.toFixed(0)}% (${mid.toFixed(0)}% mids / ${high.toFixed(0)}% highs), which can mask kick/vocals and feel boomy.`);
      else if (high < 14) feedback.push(`Top-end is restrained (${high.toFixed(0)}% highs), so the mix may feel dull or missing sparkle.`);
      else feedback.push(`Balance check: ${low.toFixed(0)}/${mid.toFixed(0)}/${high.toFixed(0)}% low/mid/high with no dominant tonal red flag.`);
    }

    if (frequencyIssue) feedback.push(`Main frequency issue: ${frequencyIssue.range} (${frequencyIssue.mainIssue}).`);

    if (poorSource || isMono) {
      const limits = [poorSource ? `source quality is rated "${sourceQuality?.rating}"` : null, isMono ? 'file is mono' : null].filter(Boolean).join(' and ');
      feedback.push(`Source limitation note: ${limits}, so mastering can improve translation but cannot fully restore missing detail or width.`);
    }

    return {
      modeName: 'Listening Coaching Mode',
      intro: 'Friendly, step-by-step mastering help driven by your measured values.',
      dynamicFeedback: feedback,
      fixOrder: clippingCount > 0 ? [
        'Step 1: Remove clipping first (highest priority).',
        'Step 2: Set loudness carefully once distortion is gone.',
        'Step 3: Shape tone and stereo image after level decisions.'
      ] : [
        'Step 1: Verify peak safety and clean source quality.',
        'Step 2: Adjust loudness in small moves while monitoring RMS and punch.',
        'Step 3: Refine low/high balance and stereo image last.'
      ]
    };
  }, [result, listeningCoachingModeEnabled, sourceQuality]);

  const frequencyBands: FrequencyBandRow[] = useMemo(() => {
    if (!result) return [];
    const low = result.lowPercent ?? 0;
    const mid = result.midPercent ?? 0;
    const high = result.highPercent ?? 0;
    const subBass = clampPercent(low * 0.52);
    const bass = clampPercent(low * 0.48 + mid * 0.08);
    const lowMids = clampPercent(mid * 0.62 + low * 0.14);
    const presence = clampPercent(mid * 0.2 + high * 0.5);
    const air = clampPercent(high * 0.42);
    return [
      { label: 'Sub Bass', range: '20–60 Hz', energy: subBass, status: bandStatus(subBass, 24, 34), humanWording: 'Rumble / sub overload' },
      { label: 'Bass', range: '60–150 Hz', energy: bass, status: bandStatus(bass, 22, 32), humanWording: 'Speaker strain / muddy warmth' },
      { label: 'Low mids', range: '150–500 Hz', energy: lowMids, status: bandStatus(lowMids, 30, 42), humanWording: 'Boxy mids / trapped sound' },
      { label: 'Presence', range: '2k–5k', energy: presence, status: bandStatus(presence, 30, 42), humanWording: 'Harsh / ear fatigue' },
      { label: 'Air', range: '8k–12k', energy: air, status: air < 14 ? 'red' : air < 20 ? 'yellow' : 'green', humanWording: air < 18 ? 'Missing sparkle' : 'Bright / airy' }
    ];
  }, [result]);
  const frequencyBalanceSummary = useMemo(() => {
    if (!result) return 'Run analysis to view your frequency heatmap and listening translation.';
    const bassBand = frequencyBands.find((band) => band.label === 'Bass');
    const subBassBand = frequencyBands.find((band) => band.label === 'Sub Bass');
    if ((bassBand && bassBand.status !== 'green') || (subBassBand && subBassBand.status === 'red')) {
      if (frequencyFeel) return `Low-end energy is elevated. Main issue: ${frequencyFeel.range} (${frequencyFeel.mainIssue}). Clean this before adding loudness.`;
      return 'The bass energy is dominating the mix and may cause speaker vibration or muddy playback.';
    }
    if (analysisState?.majorProblem) return `Frequency issues are still present. Current profile: ${analysisState.profile}.`;
    return 'Your frequency balance looks controlled overall. Keep checking against a reference track.';
  }, [analysisState, frequencyBands, frequencyFeel, result]);
  const isFinalAnalysisReady = analysisStatus === 'complete' && Boolean(result) && Boolean(analysisState);
  const hasUploadedFile = Boolean(audioDataRef.current);
  const awaitingAnalysis = hasUploadedFile && !analysisStarted;
  const audioType = isFinalAnalysisReady ? detectAudioType(result, fileName, analysisState) : awaitingAnalysis ? '—' : 'Waiting for analysis';
  const soundProfile = isFinalAnalysisReady
    ? buildSoundProfile(
      analysisState,
      sourceQuality,
      sourceQuality?.rating ?? '',
      sourceQuality?.sourceTypeGuess ?? '',
      userIntent,
      result,
      audioType,
      fileName
    ) || result?.soundProfile || 'Waiting for analysis'
    : awaitingAnalysis ? '—' : (result?.soundProfile || 'Waiting for analysis');
  const soundProfileDebugFlags = getSoundProfileDebugFlags(result, fileName);
  const visibleSourceQualityText = String(
    sourceQuality?.rating ??
    (analysisState as any)?.sourceQuality?.label ??
    (analysisState as any)?.sourceQuality ??
    ''
  ).toLowerCase();

  const visibleSourceTypeText = String(
    sourceQuality?.sourceTypeGuess ??
    (analysisState as any)?.sourceTypeGuess ??
    (analysisState as any)?.sourceQuality?.sourceTypeGuess ??
    (analysisState as any)?.audioType?.sourceTypeGuess ??
    ''
  ).toLowerCase();

  const forceLowFidelityMonoProfile =
    visibleSourceQualityText.includes('low fidelity') &&
    visibleSourceTypeText.includes('mono');

  const finalSoundProfile = forceLowFidelityMonoProfile
    ? {
      title: 'Low-fidelity mono recording',
      confidence: 'High',
      primaryIssue: 'mono low-fidelity source',
      mixCharacter: ['Mono', 'Vintage', 'Dark', 'Low fidelity'],
    }
    : {
      title: soundProfile,
      confidence: analysisState?.confidence,
      primaryIssue: analysisState?.primaryIssue,
      mixCharacter: analysisState?.mixCharacter ?? [],
    };
  const whyItSoundsThisWay = isFinalAnalysisReady ? buildWhyItSoundsThisWay(result, analysisState) : awaitingAnalysis ? ['Run analysis to explain the current sound character.'] : ['Run analysis to explain this recording.'];
  const fixSuggestions = isFinalAnalysisReady ? buildFixSuggestions(result) : [];
  const sourceConfidence = isFinalAnalysisReady ? detectSourceConfidence(result, fileName) : 'Waiting for analysis';
  const profileData = isFinalAnalysisReady ? {
    soundProfile,
    audioType,
    whyItSoundsThisWay,
    confidence: analysisState?.confidence,
    primaryIssue: analysisState?.primaryIssue
  } : null;
  console.log('PROFILE_RENDER', profileData);
  console.log('FINAL_ANALYSIS', analysisState);
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
      ...(frequencyFeel ? [{
        id: `freq-${frequencyFeel.markerLabel}`,
        label: frequencyFeel.markerLabel,
        timeSec: 0,
        color: (frequencyFeel.range === '20–60 Hz' || frequencyFeel.range === '80–150 Hz' || frequencyFeel.range === '300–800 Hz' || frequencyFeel.range === '2k–5k') ? 'red' as const : 'yellow' as const,
        explanation: `${frequencyFeel.mainIssue}. ${frequencyFeel.firstSafeFix}`,
        estimated: true,
        kind: 'estimated' as const
      }] : []),
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
    [autoMarkers, manualProblemAreas, frequencyFeel]
  );
  const isBeginnerMode = appMode === 'beginner';
  const isCreatorMode = appMode === 'creator';
  const isPreAnalysis = !analysisStarted;
  const goalVsFound = buildGoalVsFoundSummary(result, userIntent);
  const secondOpinion = buildSecondOpinion(result, analysisState, priorityFix, userIntent);
  return (
    <main className="app-shell">
      <section className="card compact">
        <header className="topbar"><div><div className="brand-row"><span className="brand-icon" aria-hidden="true"><svg viewBox="0 0 64 64" role="img"><path d="M12 38V31C12 19.4 21.4 10 33 10s21 9.4 21 21v7" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round"/><rect x="9" y="33" width="11" height="20" rx="5" fill="currentColor"/><rect x="46" y="33" width="11" height="20" rx="5" fill="currentColor"/></svg></span><h1>Studio Sense</h1></div><p className="subhead">Interactive listening + section mastering check</p><p className="subhead">Your beginner listening coach for understanding and improving music quality.</p></div></header>
  {isPreAnalysis ? (
  <>
    <section className="guidance pre-analysis-workflow">
      <h2>Studio Sense Workflow</h2>
      <ol>
        <li>Step 1 — Choose Genre</li>
        <li>Step 2 — Choose Target</li>
        <li>Step 3 — Describe the issue</li>
        <li>Step 4 — Upload audio</li>
        <li>Step 5 — Analyze with Studio Sense</li>
      </ol>
    </section>
    <section className="guidance">
      <h2>Tell Studio Sense what you’re trying to achieve</h2>
      <div className="workflow-row">
        <select value={userIntent.genre} onChange={(e) => setUserIntent((prev) => ({ ...prev, genre: e.target.value as IntentGenre }))}>
          {['Auto / Not sure', 'Blues', 'Reggae', 'Hard Rock', 'Pop', 'Hip Hop', 'EDM', 'Acoustic', 'Jazz', 'Gospel', 'Lo-fi', 'Podcast / Voice', 'Archival / Restoration', 'AI Music / Suno'].map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <select value={userIntent.outcome} onChange={(e) => setUserIntent((prev) => ({ ...prev, outcome: e.target.value as IntentOutcome }))}>
          {['Spotify / streaming release', 'YouTube upload', 'Demo mix', 'Improve clarity', 'Preserve vintage character', 'Restoration / archival listenability', 'AI music cleanup', 'Reference check only'].map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
      </div>
      <textarea value={userIntent.description} placeholder="Example: Warm late-night blues, I want the vocal clear but keep the vintage feel." onChange={(e) => setUserIntent((prev) => ({ ...prev, description: e.target.value }))} />
      <div className="workflow-row">
        <label className="upload-btn" htmlFor="audio-upload">{isAnalyzing ? 'Analyzing…' : 'Upload Audio'}</label>
        <input ref={fileInputRef} id="audio-upload" type="file" accept="audio/*" onChange={handleFileUpload} disabled={loading} />
      </div>
      <div className="workflow-row">
        {audioDataRef.current ? <p className="filename">Uploaded: {fileName}</p> : null}
      </div>
      <div className="workflow-row">
        <button className="upload-btn start-analysis-btn" type="button" onClick={handleStartAnalysis} disabled={!audioDataRef.current || loading || isAnalyzing}>
          {analysisStatus === 'processing' ? 'Studio Sense is analyzing your recording...' : 'Analyze with Studio Sense'}
        </button>
      </div>
      <p className="status">{analysisStatus === 'processing' ? `Studio Sense is analyzing your recording... (${analysisStage})` : status}</p>
      <p className="status">Debug: status={analysisStatus} | stage={analysisStage} | lastError={lastAnalysisError ?? 'none'}</p>
      {largeFileWarning ? <p className="status">{largeFileWarning}</p> : null}
      <p className="status tiny-note">Quick browser estimate — use a DAW meter for final mastering decisions.</p>
      {audioUrl ? <div className="workflow-row"><button type="button" className="upload-btn" onClick={handleNewTrack} disabled={loading || isAnalyzing}>New Track</button></div> : null}
  {isBeginnerMode ? <section className="guidance"><h2>Your Goal vs What Studio Sense Found</h2><p><strong>User goal:</strong> {userIntent.genre} → {userIntent.outcome}</p><p><strong>User issue:</strong> {userIntent.description.trim() || 'No issue described yet.'}</p><p><strong>Audio finding:</strong> {goalVsFound.audioFinding}</p><p><strong>Match result:</strong> {goalVsFound.matchResult}</p></section> : null}
      {audioUrl ? <AudioPlayer
        audioUrl={audioUrl}
        startSec={startSec}
        endSec={endSec}
        timelineMarkers={combinedProblemMarkers}
        seekToSec={seekToSec}
        onSeekHandled={() => setSeekToSec(null)}
        onTimeChange={setCurrentTime}
        onDurationChange={setDuration}
      /> : null}
      <section className="sound-profile-card"><h2>🎧 Sound Profile</h2><p>{soundProfile}</p></section>
      <section className="sound-profile-card"><h2>📼 Audio Type</h2><p>{audioType}</p></section>
      <section className="guidance"><h2>🧠 Why it sounds like this</h2><ul>{whyItSoundsThisWay.map((reason) => <li key={reason}>{reason}</li>)}</ul></section>
      <section className="guidance"><h2>🛠 How to fix it</h2>{isFinalAnalysisReady ? (fixSuggestions.length ? <ul>{fixSuggestions.map((fix) => <li key={fix}>{fix}</li>)}</ul> : <p>Looks healthy. Use minor polish and final reference checks.</p>) : <p>Run analysis first to generate a beginner-friendly fix plan.</p>}</section>
    </section>
  </>
  ) : (
  <>
  <section className="mode-toggle-wrap" aria-label="Mode switch">
    <span className="mode-toggle-label">View mode</span>
    <div className="mode-toggle" role="tablist" aria-label="Beginner and creator mode">
      <button type="button" role="tab" aria-selected={isBeginnerMode} className={`mode-toggle-btn ${isBeginnerMode ? "active" : ""}`} onClick={() => setAppMode("beginner")}>Beginner Mode</button>
      <button type="button" role="tab" aria-selected={isCreatorMode} className={`mode-toggle-btn ${isCreatorMode ? "active" : ""}`} onClick={() => setAppMode("creator")}>Creator Mode</button>
    </div>
  </section>
  <section className="workflow-row">
    <span className="filename">File: {fileName}</span>
    <span className={`pill ${loading ? "info" : "good"}`}>{loading ? "Processing" : "Ready"}</span>
    {audioUrl ? <button type="button" className="upload-btn" onClick={handleNewTrack} disabled={loading || isAnalyzing}>New Track</button> : null}
  </section>
  <p className="status">{status}</p>
  <p className="status tiny-note">Quick browser estimate — use a DAW meter for final mastering decisions.</p>
  <p className="status" style={{ fontSize: "0.8rem", opacity: 0.75 }}>Debug: analysisStatus={analysisStatus} | analysisStage={analysisStage} | status={status}</p>
  {isBeginnerMode ? <section className="guidance"><h2>Second Opinion</h2><p>{secondOpinion.intro}</p><p><strong>Does something sound off?</strong> {secondOpinion.soundsOff}</p><p><strong>What is most likely causing it?</strong> {secondOpinion.likelyCause}</p><p><strong>How confident is Studio Sense?</strong> {secondOpinion.confidence}</p><p><strong>What should I fix first?</strong> {secondOpinion.fixFirst}</p><p><strong>One thing not to do:</strong> {secondOpinion.doNotDo}</p></section> : null}

  {audioUrl && <AudioPlayer
    audioUrl={audioUrl}
    startSec={startSec}
    endSec={endSec}
    timelineMarkers={combinedProblemMarkers}
    seekToSec={seekToSec}
    onSeekHandled={() => setSeekToSec(null)}
    onTimeChange={setCurrentTime}
    onDurationChange={setDuration}
  />}

  <section className="sound-profile-card"><div style={{ color: "yellow", fontWeight: "bold", fontSize: "14px" }}>TEST EDIT ACTIVE - THIS IS THE REAL SOUND PROFILE CARD</div><h2>🎧 Sound Profile</h2><p style={{ marginTop: 0, fontSize: "0.85rem", opacity: 0.85 }}><strong>DEBUG source:</strong><br />lowFidelity={String(soundProfileDebugFlags.isVisibleLowFidelity)}<br />notRecommended={String(soundProfileDebugFlags.isVisibleNotRecommended)}<br />monoOrNarrow={String(soundProfileDebugFlags.isMonoOrNarrow)}<br />oldTapeLike={String(soundProfileDebugFlags.isOldTapeLike)}</p><p>{finalSoundProfile.title}</p>{isFinalAnalysisReady && analysisState ? <><p><strong>Confidence:</strong> {finalSoundProfile.confidence}</p><p><strong>Primary issue:</strong> {finalSoundProfile.primaryIssue}</p><p><strong>Mix Character:</strong> {finalSoundProfile.mixCharacter.length ? finalSoundProfile.mixCharacter.join(' • ') : 'Not enough mix-character data yet'}</p><p><strong>DEBUG:</strong><br />sourceQuality = {visibleSourceQualityText || 'missing'}<br />sourceTypeGuess = {visibleSourceTypeText || 'missing'}<br />forceLowFidelityMonoProfile = {String(forceLowFidelityMonoProfile)}</p></> : null}</section>
  <section className="sound-profile-card"><h2>SOURCE QUALITY</h2><p><strong>Source Quality:</strong> <span className={`pill ${toneForSourceQuality(sourceQuality?.rating)}`}>{sourceQuality?.rating ?? '—'}</span></p><p><strong>Confidence:</strong> {typeof sourceQuality?.confidence === 'number' ? `${sourceQuality.confidence}%` : '—'}</p><p><strong>Mastering Readiness:</strong> <span className={`pill ${toneForReadiness(result?.readiness)}`}>{sourceQuality?.masteringReadiness ?? '—'}</span></p><p><strong>Source type guess:</strong> {sourceQuality?.sourceTypeGuess ?? 'Run analysis to detect source type.'}</p><p><strong>Coach note:</strong> {isCreatorMode && result ? `${sourceQuality?.sourceTypeGuess ?? ''}${typeof result.peakDb === 'number' ? `, peak ${result.peakDb.toFixed(1)} dBFS` : ''}${typeof result.lufsEstimate === 'number' ? `, LUFS ${result.lufsEstimate.toFixed(1)}.` : '.'} ${sourceQuality?.note ?? ''}` : sourceQuality?.note ?? 'Run analysis for source guidance.'}</p><p><em>Mastering readiness is different from source quality. Professional studio exports are often quieter before mastering. Raw WAV files may sound less exciting before final mastering.</em></p></section>
  <section className="sound-profile-card"><h2>📼 Audio Type</h2><p>{audioType}</p><p><strong>Source Confidence:</strong> {sourceConfidence}</p></section>
  <section className="guidance"><h2>🧠 Why it sounds like this</h2><ul>{whyItSoundsThisWay.map((reason) => <li key={reason}>{reason}</li>)}</ul></section>
  <section className="guidance"><h2>🛠 How to fix it</h2>{fixSuggestions.length ? <ul>{fixSuggestions.map((fix) => <li key={fix}>{fix}</li>)}</ul> : <p>Looks healthy. Use minor polish and final reference checks.</p>}</section>
  <section className="guidance"><h2>🎛 Mastering suggestion</h2><p>{buildTopMasteringSuggestion(result)}</p></section>
  <section className="guidance frequency-balance"><h2>Frequency Balance</h2>{frequencyBands.length ? <><p>{frequencyBalanceSummary}</p><div className="frequency-grid">{frequencyBands.map((band) => <div key={band.label} className="frequency-row"><div className="frequency-row-head"><strong>{band.label} <span>({band.range})</span></strong><span className={`pill ${band.status === 'green' ? 'good' : band.status === 'yellow' ? 'warn' : 'bad'}`}>{band.energy.toFixed(0)}%</span></div><div className="frequency-meter" role="img" aria-label={`${band.label} energy ${band.energy.toFixed(0)} percent`}><div className={`frequency-fill ${band.status}`} style={{ width: `${band.energy}%` }} /></div><p>{band.humanWording}</p></div>)}</div></> : <p className="empty">Run analysis to see frequency distribution.</p>}</section>
  <section className="guidance"><h2>Frequency Feel</h2>{frequencyFeel ? <><p><strong>Main frequency issue:</strong> {frequencyFeel.range} {frequencyFeel.range === '8k–12k' ? 'too weak' : 'too strong'}</p><p><strong>What it feels like:</strong> {frequencyFeel.listenerFeeling}</p><p><strong>First safe fix:</strong> {frequencyFeel.firstSafeFix}</p><p><strong>What NOT to do:</strong> {frequencyFeel.avoid}</p></> : <p className="empty">No dominant frequency problem detected.</p>}</section>
  <section className="guidance"><h2>Intent-Aware Coach</h2>{intentAwareCoach ? <><p><strong>What you’re aiming for:</strong> {intentAwareCoach.goal}{userIntent.description ? ` — ${userIntent.description}` : ''}</p><p><strong>What matters most for this goal:</strong> {intentAwareCoach.matters}</p><p><strong>What to fix first:</strong> {intentAwareCoach.fixFirst}</p><p><strong>What to avoid:</strong> {intentAwareCoach.avoid}</p><p><strong>Realistic outcome:</strong> {intentAwareCoach.realistic}</p></> : <p className="empty">Set your intent and run analysis for goal-aware coaching.</p>}</section>


  <ListeningCoach lufs={result?.lufsEstimate ?? result?.lufs} peak={result?.peakDb} clipping={result?.clippingCount} rms={result?.rmsDb} channels={result?.channels} sourceQuality={sourceQuality?.rating} balance={{ low: result?.lowPercent ?? 0, mid: result?.midPercent ?? 0, high: result?.highPercent ?? 0 }} mainFrequencyIssue={frequencyFeel ? `${frequencyFeel.range} (${frequencyFeel.mainIssue})` : null} isCreatorMode={isCreatorMode} userIntent={userIntent} /><section className="guidance"><h2>🎧 Listening Coach</h2>{listeningCoach ? <><h3>🎧 Quick Summary</h3><ul>{listeningCoach.quickSummary.map((item) => <li key={`coach-quick-${item}`}>{item}</li>)}</ul><h3>⚠️ What Matters</h3><ul>{listeningCoach.whatMatters.map((item) => <li key={`coach-matters-${item}`}>{item}</li>)}</ul><h3>🛠️ What To Do First</h3><ol>{listeningCoach.whatToDoFirst.map((item) => <li key={`coach-first-${item}`}>{item}</li>)}</ol><h3>🎧 What to listen for</h3><ul>{listeningCoach.whatToListenFor.map((item) => <li key={`coach-listen-${item}`}>{item}</li>)}</ul><h3>🚫 What NOT To Do</h3><ul>{listeningCoach.whatNotToDo.map((item) => <li key={`coach-avoid-${item}`}>{item}</li>)}</ul><h3>🎯 Coach Note</h3><p>{listeningCoach.coachNote}</p></> : <p className="empty">Run analysis to unlock your beginner-friendly Listening Coach plan.</p>}</section>
  <section className="guidance"><h2>🟦 Listening Coach: Listening Coaching Mode</h2><div className="workflow-row"><button className="upload-btn" type="button" onClick={() => setListeningCoachingModeEnabled((v) => !v)}>{listeningCoachingModeEnabled ? 'Mode: On' : 'Mode: Off'}</button></div>{listeningCoachingMode ? <><p>{listeningCoachingMode.intro}</p><h3>Dynamic feedback</h3><ul>{listeningCoachingMode.dynamicFeedback.map((item) => <li key={`dynamic-${item}`}>{item}</li>)}</ul><h3>Fix Order</h3><ol>{listeningCoachingMode.fixOrder.map((step) => <li key={step}>{step}</li>)}</ol></> : <p className="empty">Turn on Listening Coaching Mode and run analysis to get guided feedback.</p>}</section>
  {isCreatorMode ? <section className="verdicts"><h2>Whole Track Analysis</h2>{analysisStarted ? (verdictItems.length > 0 ? <ul>{verdictItems.map((item) => <li key={item.label}><span className={`pill ${item.tone}`}>{item.label}</span><span>{item.text}</span></li>)}</ul> : <p className="empty">Run analysis to see verdicts.</p>) : <p className="empty">No analysis yet.</p>}</section> : null}

  {isCreatorMode && analysisStarted ? <section className="verdicts problem-timeline"><h2>Markers (enhanced)</h2>{hasAnalyzedTrack ? <>{combinedProblemMarkers.length ? <><ul>{combinedProblemMarkers.map((m) => { const guidance = markerGuidance[m.label] ?? { title: m.label, explanation: m.explanation, fix: 'Review this section and compare against a reference track.', badgeTone: 'warn' as const }; return <li key={m.id} className="timeline-item"><div className="timeline-title-row"><span className={`pill ${guidance.badgeTone}`}>{guidance.title}</span><strong>{formatClock(m.timeSec)}</strong></div><span>{`${m.label} → ${guidance.fix}`}</span><span>{guidance.explanation}</span><button className="jump-btn" type="button" onClick={() => setSeekToSec(m.timeSec)}>Jump</button></li>; })}</ul></> : <p className="empty">✅ No major problem sections detected. Your track is close to release-ready.</p>}</> : <p className="empty">Upload a track to generate problem markers.</p>}</section> : null}

  {isCreatorMode && analysisStarted ? <section className="guidance"><h2>Section selection</h2><div className="workflow-row"><button className="upload-btn" type="button" onClick={() => setStartSec(currentTime)} disabled={!audioBuffer}>Mark start</button><button className="upload-btn" type="button" onClick={() => setEndSec(currentTime)} disabled={!audioBuffer}>Mark end</button><button className="upload-btn" type="button" onClick={() => { setStartSec(null); setEndSec(null); setSectionResult(null); }} disabled={!audioBuffer}>Clear section</button></div>
    <div className="metrics-grid"><div className="metric"><span>Start</span><strong>{formatClock(startSec)}</strong></div><div className="metric"><span>End</span><strong>{formatClock(endSec)}</strong></div><div className="metric"><span>Length</span><strong>{hasSelection ? formatClock((endSec ?? 0) - (startSec ?? 0)) : '00:00'}</strong></div><div className="metric"><span>Manual (sec)</span><strong><input className="time-input" type="number" min={0} max={duration} value={startSec ?? 0} onChange={(e) => setStartSec(Number(e.target.value))} /> <input className="time-input" type="number" min={0} max={duration} value={endSec ?? 0} onChange={(e) => setEndSec(Number(e.target.value))} /></strong></div></div>
    <div className="workflow-row"><button className="upload-btn" type="button" disabled={loading || !audioBuffer || !hasSelection} onClick={analyzeSelectedSection}>Analyze selected section</button></div>
  </section> : null}

  {isCreatorMode ? <section className="metrics-grid">
    <div className="metric"><span>Source Quality</span><strong><span className={`pill ${toneForSourceQuality(sourceQuality?.rating)}`}>{sourceQuality?.rating ?? '—'}</span></strong></div><div className="metric"><span>Release Readiness</span><strong><span className={`pill ${toneForReadiness(result?.readiness)}`}>{result?.readiness ?? '—'}</span></strong></div><div className="metric"><span>Score</span><strong>{formatScore(result?.score)}</strong></div><div className="metric"><span>LUFS estimate</span><strong>{formatDb(result?.lufsEstimate)}</strong></div><div className="metric"><span>Peak dBFS</span><strong>{formatDb(result?.peakDb)}</strong></div><div className="metric"><span>RMS dB</span><strong>{formatDb(result?.rmsDb)}</strong></div><div className="metric"><span>Clipping count</span><strong>{formatNumber(result?.clippingCount, 0)}</strong></div><div className="metric"><span>Duration (s)</span><strong>{formatNumber(result?.durationSec, 2)}</strong></div><div className="metric"><span>Sample rate</span><strong>{formatNumber(result?.sampleRate, 0)}</strong></div><div className="metric"><span>Channels</span><strong>{formatNumber(result?.channels, 0)}</strong></div><div className="metric span-2"><span>Low / Mid / High balance</span><strong>{formatNumber(result?.lowPercent, 0)} / {formatNumber(result?.midPercent, 0)} / {formatNumber(result?.highPercent, 0)}%</strong></div><div className="metric span-2"><span>Source type guess</span><strong>{sourceQuality?.sourceTypeGuess ?? 'Run analysis to classify source type.'}</strong></div><div className="metric span-2"><span>Source quality note</span><strong>{sourceQuality?.note ?? 'Run analysis to classify source quality.'}</strong></div>
  </section> : null}
  {isCreatorMode && result ? <section className="guidance"><h2>Decision Debug</h2><p className="empty">Raw values used for coaching decisions.</p><ul><li>LUFS: {formatDb(result.lufsEstimate ?? result.lufs)}</li><li>Peak dBFS: {formatDb(result.peakDb)}</li><li>Clipping count: {formatNumber(result.clippingCount, 0)}</li><li>RMS dB: {formatDb(result.rmsDb)}</li><li>Stereo: {(result.channels ?? 2) === 1 ? 'Mono' : 'Stereo'}</li><li>Source quality: {sourceQuality?.rating ?? '—'}</li><li>Low/Mid/High: {formatNumber(result.lowPercent, 0)} / {formatNumber(result.midPercent, 0)} / {formatNumber(result.highPercent, 0)}%</li><li>Main frequency issue: {frequencyFeel ? `${frequencyFeel.range} (${frequencyFeel.mainIssue})` : 'None detected'}</li><li>Frame count: {analysisDebug && typeof analysisDebug.frameCount === 'number' ? analysisDebug.frameCount : '—'}</li></ul></section> : null}

  {isCreatorMode && analysisStarted ? <section className="guidance"><h2>Selected Section Analysis</h2><p className="empty">Browser-based FFT analysis of the selected section.</p>{sectionResult ? <><section className="metrics-grid"><div className="metric"><span>Readiness</span><strong><span className={`pill ${toneForReadiness(sectionResult.readiness)}`}>{sectionResult.readiness ?? '—'}</span></strong></div><div className="metric"><span>Score</span><strong>{formatScore(sectionResult.score)}</strong></div><div className="metric"><span>LUFS estimate</span><strong>{formatDb(sectionResult.lufsEstimate)}</strong></div><div className="metric"><span>Peak dBFS</span><strong>{formatDb(sectionResult.peakDb)}</strong></div><div className="metric"><span>RMS dB</span><strong>{formatDb(sectionResult.rmsDb)}</strong></div><div className="metric"><span>Clipping count</span><strong>{formatNumber(sectionResult.clippingCount, 0)}</strong></div><div className="metric span-2"><span>Low / Mid / High balance</span><strong>{formatNumber(sectionResult.lowPercent, 0)} / {formatNumber(sectionResult.midPercent, 0)} / {formatNumber(sectionResult.highPercent, 0)}%</strong></div></section>{sectionNarrative.map((n) => <p key={n}>{n}</p>)}<div className="verdicts section-verdicts"><ul>{[{ label: 'Loudness verdict', text: sectionResult.loudnessVerdict }, { label: 'Peak safety verdict', text: sectionResult.peakSafetyVerdict }, { label: 'Clipping warning', text: sectionResult.clippingVerdict }, { label: 'Spectrum verdict', text: sectionResult.balanceVerdict }, { label: 'Mastering suggestion', text: sectionResult.masteringSuggestion }].filter((item) => Boolean(item.text)).map((item) => <li key={item.label}><span className="pill info">{item.label}</span><span>{item.text}</span></li>)}</ul></div><div className="workflow-row"><input className="note-input" value={problemNote} placeholder="Short problem note" onChange={(e) => setProblemNote(e.target.value)} /><button className="upload-btn" type="button" onClick={() => { if (!hasSelection || !sectionResult) return; setManualProblemAreas((prev) => [{ id: `${Date.now()}`, startSec: startSec ?? 0, endSec: endSec ?? 0, note: problemNote || 'Marked problem area', metrics: sectionResult }, ...prev]); setProblemNote(''); }}>Mark as problem area</button></div></> : <p className="empty">Select a valid start/end range, then analyze selected section.</p>}</section> : null}

  {analysisStarted ? <ReleaseChecklist
    result={result}
    autoMarkerCount={combinedProblemMarkers.length}
    frequencyIssueLabel={frequencyFeel ? `${frequencyFeel.range} ${frequencyFeel.range === '8k–12k' ? 'too weak' : 'too strong'}` : null}
    intentOutcome={userIntent.outcome}
  /> : null}


  {isBeginnerMode ? <section className="guidance priority-fix"><h2>🎧 Listening Coach — What to Fix First</h2>{priorityFix ? <><h3>{priorityFix.title}</h3><p>{priorityFix.message}</p></> : <p className="empty">Run analysis to see your highest-priority fix.</p>}</section> : null}{analysisStarted ? <section className="guidance"><h2>Plain English Summary</h2>{plainEnglishSummary ? <><h3>What you're hearing</h3><ul>{plainEnglishSummary.hearing.map((item) => <li key={`hear-${item}`}>{item}</li>)}</ul><h3>Why it’s happening</h3><ul>{plainEnglishSummary.why.map((item) => <li key={`why-${item}`}>{item}</li>)}</ul><h3>What to do next</h3><ol>{plainEnglishSummary.next.map((item) => <li key={`next-${item}`}>{item}</li>)}</ol></> : <p className="empty">Run analysis to see a beginner-friendly summary.</p>}</section> : null}

  <section className="guidance"><h2>Fix Your Track — Step by Step</h2>{result ? <><p className="empty">Your Listening Coach recommends this order so each move helps the next one.</p><ol><li>{((result.clippingCount ?? 0) > 0 || (typeof result.peakDb === 'number' && result.peakDb >= -1)) ? 'Fix clipping and peak safety first before chasing loudness.' : 'Peaks are already safe, so start with loudness and tone refinement.'}</li><li>Then adjust loudness in small moves so it feels competitive without sounding crushed.</li><li>Then rebalance low-end or high-end only if the tone still feels off.</li><li>Then re-check against a reference track and confirm it translates well.</li></ol></> : <p className="empty">Run analysis to get your Listening Coach step-by-step repair order.</p>}</section>

  {analysisStarted ? <section className="guidance"><h2>Auto Fix Plan</h2>{autoFixPlan ? <><h3>1) What is wrong</h3><ul>{autoFixPlan.wrong.map((item) => <li key={`wrong-${item}`}>{item}</li>)}</ul><h3>2) Why it matters</h3><ul>{autoFixPlan.matters.map((item) => <li key={`matters-${item}`}>{item}</li>)}</ul><h3>3) What to try first</h3><ol>{autoFixPlan.first.map((item) => <li key={`first-${item}`}>{item}</li>)}</ol><h3>4) What to listen for</h3><ul>{autoFixPlan.listenFor.map((item) => <li key={`listen-${item}`}>{item}</li>)}</ul><h3>5) What NOT to do</h3><ul>{autoFixPlan.avoid.map((item) => <li key={`avoid-${item}`}>{item}</li>)}</ul><h3>6) Source quality</h3><ul>{autoFixPlan.sourceQuality.map((item) => <li key={`source-${item}`}>{item}</li>)}</ul><h3>7) Release Readiness</h3><ul>{autoFixPlan.readiness.map((item) => <li key={`ready-${item}`}>{item}</li>)}</ul><h3>🎧 Listening Coach Tip</h3><p>Fix the loudest peaks first.</p><p>Then bring the overall volume up slowly.</p><p>Only adjust tone after that if something still feels off.</p><p>Make small changes and listen each time.</p><p>You don’t need to get it perfect.</p><p>If it sounds better than before, you’re improving.</p></> : <p className="empty">Run analysis to generate a beginner-friendly repair plan.</p>}</section> : null}

  {isCreatorMode ? <section className="guidance"><h2>Target guidance</h2><p>Target LUFS: {TARGET_LUFS}. Safe peak target: below {SAFE_PEAK_DBFS} dBFS.</p><p>Browser-based estimate (including LUFS estimate), not a replacement for studio metering.</p></section> : null}

  <section className="guidance"><h2>Listening Coach Plan</h2><div className="workflow-row"><button className="upload-btn" type="button" onClick={runSafeModeAutoFix} disabled={!result}>Build Listening Coach Plan</button></div>{safeModeFixPlan ? <><h3>🎧 Quick Coach Summary</h3>{safeModeFixPlan.quickSummary.length ? <ul>{safeModeFixPlan.quickSummary.map((item) => <li key={`quick-${item}`}>{item}</li>)}</ul> : <p>• No major red flags detected.</p>}<p><strong>{safeModeFixPlan.startWith}</strong></p><h3>Issue Priority</h3><ul>{safeModeFixPlan.issueSeverity.map((item) => <li key={`severity-${item.label}`}><span className={`pill ${item.severity === 'critical' ? 'bad' : item.severity === 'important' ? 'warn' : 'good'}`}>{item.severity === 'critical' ? '🔴 Critical' : item.severity === 'important' ? '🟠 Important' : '🟢 Optional'}</span> <span>{item.label}</span></li>)}</ul><h3>🎧 WHAT I HEAR</h3><ul>{safeModeFixPlan.whatIHear.map((item) => <li key={`hear-${item}`}>{item}</li>)}</ul><h3>⚠️ WHAT MATTERS</h3><ul>{safeModeFixPlan.whatMatters.map((item) => <li key={`matters-${item}`}>{item}</li>)}</ul><h3>🛠️ WHAT TO DO FIRST</h3><ol>{safeModeFixPlan.whatToDoFirst.map((item) => <li key={`first-${item}`}>{item}</li>)}</ol><h3>🎧 WHAT TO LISTEN FOR</h3><ul><li>Does it feel as loud as other songs?</li><li>Does the bass feel full but not heavy?</li><li>Do vocals/instruments stay clear?</li><li>Do loud parts stay clean without crunch or distortion?</li></ul><h3>🚫 WHAT NOT TO DO</h3><ul>{safeModeFixPlan.whatNotToDo.map((item) => <li key={`avoid-${item}`}>{item}</li>)}</ul><h3>🎯 COACH NOTE</h3><p>{safeModeFixPlan.coachNote}</p></> : <p className="empty">Run analysis, then tap “Build Listening Coach Plan” for a structured listening coach plan.</p>}</section>
  </>
  )}
      </section>
    </main>
  );
}
