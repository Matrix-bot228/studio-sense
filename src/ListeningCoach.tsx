type ListeningCoachProps = {
  lufs: number | null | undefined;
  peak: number | null | undefined;
  balance: {
    low: number;
    high: number;
  };
};

type CoachFeedback = {
  title: string;
  message: string;
};

function ListeningCoach({ lufs, peak, balance }: ListeningCoachProps) {
  const getFeedback = (): CoachFeedback[] => {
    const feedback: CoachFeedback[] = [];

    if (typeof peak === 'number' && peak > -1) {
      feedback.push({
        title: 'Fix peaks first',
        message:
          'Some parts are hitting too hard. Lower your limiter ceiling to around -1 dB. It should feel smoother, not sharp.',
      });
    }

    if (typeof lufs === 'number' && lufs < -14) {
      feedback.push({
        title: 'Bring the track forward',
        message:
          'Your track feels a bit quiet. Slowly increase gain until it feels close to your favourite song — stop before it gets harsh.',
      });
    }

    if (balance.low < 25) {
      feedback.push({
        title: 'Add warmth',
        message: 'The low end feels light. Try a gentle boost around 80–150 Hz to add body.',
      });
    }

    if (balance.high < 20) {
      feedback.push({
        title: 'Add clarity',
        message:
          'The top end feels slightly muted. Add a soft high shelf to bring back clarity — stop as soon as it sounds right.',
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
      <h2>🎧 Listening Coach</h2>
      {feedback.map((item) => (
        <div key={item.title}>
          <h3>{item.title}</h3>
          <p>{item.message}</p>
        </div>
      ))}
    </section>
  );
}

export default ListeningCoach;
