type UserIntent = {
  genre: string;
  outcome: string;
  description: string;
};

type ListeningCoachProps = {
  lufs: number | null | undefined;
  peak: number | null | undefined;
  clipping?: number | null | undefined;
  rms?: number | null | undefined;
  channels?: number | null | undefined;
  sourceQuality?: string | null | undefined;
  balance: {
    low: number;
    mid?: number;
    high: number;
  };
  mainFrequencyIssue?: string | null | undefined;
  isCreatorMode?: boolean;
  userIntent: UserIntent;
};

type CoachFeedback = {
  title: string;
  message: string;
};

type IntentKeyword = 'bass' | 'vocal' | 'harsh' | 'loudness' | 'distortion' | 'stereo';

type GoalMatchSummary = {
  audioFinding: string;
  matchResult: string;
};

function ListeningCoach({ lufs, peak, clipping = 0, rms, channels, sourceQuality, balance, mainFrequencyIssue, isCreatorMode = false, userIntent }: ListeningCoachProps) {
  const clippingCount = clipping ?? 0;
  const description = userIntent.description.toLowerCase();

  const getIntentKeywords = (): IntentKeyword[] => {
    const map: Array<{ key: IntentKeyword; pattern: RegExp }> = [
      { key: 'bass', pattern: /(bass|low end|low-end|boomy|rumble|muddy)/i },
      { key: 'vocal', pattern: /(vocal|voice|lyrics|clarity)/i },
      { key: 'harsh', pattern: /(harsh|sharp|painful|bright)/i },
      { key: 'loudness', pattern: /(quiet|loud|volume|streaming)/i },
      { key: 'distortion', pattern: /(distorted|clipping|crunchy)/i },
      { key: 'stereo', pattern: /(stereo|mono|wide|narrow)/i }
    ];

    return map.filter((item) => item.pattern.test(description)).map((item) => item.key);
  };

  const getGoalMatchSummary = (): GoalMatchSummary => {
    const lufsValue = typeof lufs === 'number' ? lufs : null;
    const loudnessGap = lufsValue !== null ? Math.abs(-14 - lufsValue).toFixed(1) : null;

    if (description.trim().length === 0) {
      return {
        audioFinding: 'No issue description provided yet. Studio Sense is using measured audio data only.',
        matchResult: 'Partly confirmed: add your issue description to get a stronger goal-to-audio match check.'
      };
    }

    if (/(bass|low end|low-end|boomy|rumble|muddy)/i.test(description)) {
      if (balance.low > 45) {
        return {
          audioFinding: `Low-end is elevated (${balance.low.toFixed(0)}%), which supports a bass/rumble concern.`,
          matchResult: 'Confirmed: the audio supports your concern.'
        };
      }
      return {
        audioFinding: `Low-end is not dominant (${balance.low.toFixed(0)}%). Another issue likely has higher priority.`,
        matchResult: 'Not the main issue: the scan found a different priority.'
      };
    }

    if (/(vocal|voice|lyrics|clarity)/i.test(description)) {
      const vocalMasked = balance.low > 40 || (balance.mid ?? 0) < 20 || balance.high < 16;
      if (vocalMasked) {
        return {
          audioFinding: `Vocal clarity risk detected: low-end at ${balance.low.toFixed(0)}% with limited mid/high support can mask lyrics.`,
          matchResult: 'Partly confirmed: your concern is present, but another issue is bigger.'
        };
      }
      return {
        audioFinding: 'Measured tonal balance does not show strong vocal masking from spectrum alone.',
        matchResult: 'Not the main issue: the scan found a different priority.'
      };
    }

    if (/(harsh|sharp|painful|bright)/i.test(description)) {
      if (balance.high > 28 || mainFrequencyIssue?.includes('2k–5k')) {
        return {
          audioFinding: `High/upper-mid energy is elevated (${balance.high.toFixed(0)}%), consistent with harshness.`,
          matchResult: 'Confirmed: the audio supports your concern.'
        };
      }
      return {
        audioFinding: `Highs are not elevated (${balance.high.toFixed(0)}%), so harshness may come from distortion or source quality limits.`,
        matchResult: 'Partly confirmed: your concern is present, but another issue is bigger.'
      };
    }

    if (/(quiet|loud|volume|streaming)/i.test(description) && lufsValue !== null) {
      if (lufsValue < -14) {
        return {
          audioFinding: `Loudness is ${lufsValue.toFixed(1)} LUFS, about ${loudnessGap} LUFS below a -14 streaming reference.`,
          matchResult: 'Confirmed: the audio supports your concern.'
        };
      }
      return {
        audioFinding: `Loudness is ${lufsValue.toFixed(1)} LUFS, already near common streaming level.`,
        matchResult: 'Not the main issue: the scan found a different priority.'
      };
    }

    return {
      audioFinding: mainFrequencyIssue ? `Primary measured issue: ${mainFrequencyIssue}.` : 'No dominant single frequency issue detected.',
      matchResult: 'Partly confirmed: your concern is present, but another issue is bigger.'
    };
  };

  const getFeedback = (): CoachFeedback[] => {
    const feedback: CoachFeedback[] = [];
    const keywordFlags = getIntentKeywords();
    const wantsBassPriority = keywordFlags.includes('bass');

    if (wantsBassPriority && balance.low > 45) {
      feedback.push({
        title: 'Start with low-end control (matches your issue)',
        message: `You mentioned bass/low-end concerns, and low energy is ${balance.low.toFixed(0)}%. Trim sub/bass first so the rest of the mix becomes easier to judge.`
      });
    }

    if (keywordFlags.includes('vocal') && (balance.low > 40 || balance.high < 16 || (balance.mid ?? 0) < 20)) {
      feedback.push({
        title: 'Improve vocal clarity by unmasking it',
        message: `You asked about vocal clarity. Current balance suggests bass masking risk (low-end ${balance.low.toFixed(0)}%). Reducing bass congestion can reveal voice and lyrics before boosting highs.`
      });
    }

    if (keywordFlags.includes('loudness') && typeof lufs === 'number' && lufs < -14) {
      const gap = Math.abs(-14 - lufs).toFixed(1);
      feedback.push({
        title: 'Close the loudness gap safely',
        message: `You mentioned loudness/streaming level. At ${lufs.toFixed(1)} LUFS, the track is about ${gap} LUFS below -14. Raise level gradually while keeping true peak near -1 dBFS.`
      });
    }

    if (keywordFlags.includes('harsh') && balance.high <= 28 && !mainFrequencyIssue?.includes('2k–5k')) {
      feedback.push({
        title: 'Harshness may not be pure top-end EQ',
        message: `You reported harshness, but highs are not elevated (${balance.high.toFixed(0)}%). The sharper feeling may come from clipping/distortion or source quality limits rather than only high-frequency boost.`
      });
    }

    if (clippingCount > 0) {
      feedback.push({ title: 'Fix clipping first', message: `Clipping was detected (${clippingCount} samples). This is priority #1: lower limiter/output until distortion is gone, then continue mastering.` });
    } else if (typeof peak === 'number' && peak >= -1) {
      feedback.push({ title: 'Create safer peak headroom', message: `Peak is ${peak.toFixed(1)} dBFS. Pull output down slightly so your true peak target stays near -1 dBFS before loudness moves.` });
    } else if (typeof peak === 'number') {
      feedback.push({ title: 'Peak headroom is safe', message: `Peak is safe at ${peak.toFixed(1)} dBFS, so you can focus on tone/loudness instead of clipping repair.` });
    }

    const poorSource = sourceQuality === 'Low Fidelity Source' || sourceQuality === 'Standard Compressed Audio';
    if (typeof lufs === 'number' && lufs < -14 && poorSource) {
      feedback.push({ title: 'Loudness needs context', message: `Loudness is low (${lufs.toFixed(1)} LUFS). Clean the source before pushing loudness.` });
    } else if (typeof lufs === 'number' && lufs < -14) {
      feedback.push({ title: 'Bring the track forward', message: `LUFS is ${lufs.toFixed(1)}, so the track will feel quiet on streaming. Raise level gradually while keeping peaks controlled.` });
    }

    if (!wantsBassPriority && balance.low > 45) {
      feedback.push({ title: 'Control low-end buildup', message: `Low-end is ${balance.low.toFixed(0)}% of spectral energy, which can mask clarity and make the mix boomy. Trim sub/bass before more limiting.` });
    } else if (balance.low < 25) {
      feedback.push({ title: 'Add warmth', message: 'The low end feels light. Try a gentle boost around 80–150 Hz to add body.' });
    }

    if (balance.high < 16) {
      feedback.push({ title: 'Recover sparkle', message: `High/air energy is ${balance.high.toFixed(0)}%, so the mix may sound dull or closed-in. Use subtle top-end shaping to restore openness.` });
    }

    if (typeof rms === 'number') {
      feedback.push({ title: 'Check signal strength', message: rms < -22 ? `RMS is ${rms.toFixed(1)} dB, indicating low average energy.` : `RMS is ${rms.toFixed(1)} dB, giving healthy average signal strength.` });
    }

    if ((channels ?? 2) === 1 || poorSource) {
      feedback.push({ title: 'Source quality limits final polish', message: `${(channels ?? 2) === 1 ? 'Mono source reduces stereo width. ' : ''}${poorSource ? `${sourceQuality} limits recoverable detail. ` : ''}Mastering can improve translation but cannot fully restore missing width/detail.` });
    }

    if (mainFrequencyIssue) {
      feedback.push({ title: 'Main frequency priority', message: `Primary tonal issue detected: ${mainFrequencyIssue}. Fix this before broad EQ moves.` });
    }

    if (!feedback.length) feedback.push({ title: 'Nice balance', message: 'Your loudness, peak safety, and tone feel healthy. Make tiny moves only if needed.' });
    return feedback;
  };

  const feedback = getFeedback();
  const goalMatch = getGoalMatchSummary();

  return (
    <section className="guidance">
      <h2>🎯 Fix Your Track (Step-by-Step)</h2>
      <div>
        <h3>Your Goal vs What Studio Sense Found</h3>
        <p><strong>User goal:</strong> {userIntent.genre} → {userIntent.outcome}</p>
        <p><strong>User issue:</strong> {userIntent.description.trim() || 'No issue described yet.'}</p>
        <p><strong>Audio finding:</strong> {goalMatch.audioFinding}</p>
        <p><strong>Match result:</strong> {goalMatch.matchResult}</p>
      </div>
      {feedback.map((item, index) => (
        <div key={item.title}>
          <h3>{`Step ${index + 1} — ${item.title}`}</h3>
          <p>{item.message}</p>
        </div>
      ))}
      {isCreatorMode ? (
        <div>
          <h3>Debug values (Creator Mode)</h3>
          <p>LUFS: {typeof lufs === 'number' ? lufs.toFixed(1) : '—'} | Peak: {typeof peak === 'number' ? `${peak.toFixed(1)} dBFS` : '—'} | Clipping: {clippingCount} | RMS: {typeof rms === 'number' ? `${rms.toFixed(1)} dB` : '—'} | Stereo: {(channels ?? 2) === 1 ? 'Mono' : 'Stereo'} | Source: {sourceQuality ?? '—'} | Low/Mid/High: {balance.low.toFixed(0)}/{(balance.mid ?? 0).toFixed(0)}/{balance.high.toFixed(0)} | Main issue: {mainFrequencyIssue ?? 'None'}</p>
        </div>
      ) : null}
    </section>
  );
}

export default ListeningCoach;
