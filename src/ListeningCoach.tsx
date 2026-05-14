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
};

type CoachFeedback = {
  title: string;
  message: string;
};

function ListeningCoach({ lufs, peak, clipping = 0, rms, channels, sourceQuality, balance, mainFrequencyIssue, isCreatorMode = false }: ListeningCoachProps) {
  const clippingCount = clipping ?? 0;

  const getFeedback = (): CoachFeedback[] => {
    const feedback: CoachFeedback[] = [];

    if (clippingCount > 0) {
      feedback.push({
        title: 'Fix clipping first',
        message:
          `Clipping was detected (${clippingCount} samples). This is priority #1: lower limiter/output until distortion is gone, then continue mastering.`,
      });
    } else if (typeof peak === 'number' && peak >= -1) {
      feedback.push({
        title: 'Create safer peak headroom',
        message: `Peak is ${peak.toFixed(1)} dBFS. Pull output down slightly so your true peak target stays near -1 dBFS before loudness moves.`,
      });
    } else if (typeof peak === 'number') {
      feedback.push({
        title: 'Peak headroom is safe',
        message: `Peak is safe at ${peak.toFixed(1)} dBFS, so you can focus on tone/loudness instead of clipping repair.`,
      });
    }

    const poorSource = sourceQuality === 'Low Fidelity Source' || sourceQuality === 'Standard Compressed Audio';
    if (typeof lufs === 'number' && lufs < -14 && poorSource) {
      feedback.push({
        title: 'Loudness needs context',
        message: `Loudness is low (${lufs.toFixed(1)} LUFS). Clean the source before pushing loudness.`,
      });
    } else if (typeof lufs === 'number' && lufs < -14) {
      feedback.push({
        title: 'Bring the track forward',
        message: `LUFS is ${lufs.toFixed(1)}, so the track will feel quiet on streaming. Raise level gradually while keeping peaks controlled.`,
      });
    }

    if (balance.low > 45) {
      feedback.push({
        title: 'Control low-end buildup',
        message: `Low-end is ${balance.low.toFixed(0)}% of spectral energy, which can mask clarity and make the mix boomy. Trim sub/bass before more limiting.`,
      });
    } else if (balance.low < 25) {
      feedback.push({
        title: 'Add warmth',
        message: 'The low end feels light. Try a gentle boost around 80–150 Hz to add body.',
      });
    }

    if (balance.high < 16) {
      feedback.push({
        title: 'Recover sparkle',
        message: `High/air energy is ${balance.high.toFixed(0)}%, so the mix may sound dull or closed-in. Use subtle top-end shaping to restore openness.`,
      });
    }

    if (typeof rms === 'number') {
      feedback.push({
        title: 'Check signal strength',
        message: rms < -22 ? `RMS is ${rms.toFixed(1)} dB, indicating low average energy.` : `RMS is ${rms.toFixed(1)} dB, giving healthy average signal strength.`,
      });
    }

    if ((channels ?? 2) === 1 || poorSource) {
      feedback.push({
        title: 'Source quality limits final polish',
        message: `${(channels ?? 2) === 1 ? 'Mono source reduces stereo width. ' : ''}${poorSource ? `${sourceQuality} limits recoverable detail. ` : ''}Mastering can improve translation but cannot fully restore missing width/detail.`,
      });
    }

    if (mainFrequencyIssue) {
      feedback.push({
        title: 'Main frequency priority',
        message: `Primary tonal issue detected: ${mainFrequencyIssue}. Fix this before broad EQ moves.`,
      });
    }

    if (!feedback.length) {
      feedback.push({
        title: 'Nice balance',
        message: 'Your loudness, peak safety, and tone feel healthy. Make tiny moves only if needed.',
      });
    }

    return feedback;
  };

  const feedback = getFeedback();

  return (
    <section className="guidance">
      <h2>🎯 Fix Your Track (Step-by-Step)</h2>
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
