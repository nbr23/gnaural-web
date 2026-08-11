import './HeadphoneNotice.css';

export interface HeadphoneNoticeProps {
  onDismiss: () => void;
}

/**
 * The one-time notice PLAN.md §4.4 and §5.1 both ask for.
 *
 * **Not decorative.** A binaural beat exists only between two ears (§1) — it is a difference the
 * listener's hearing constructs from two channels, not a sound in either one — so through a
 * speaker the app does not work in a subtle way, it does not work at all. Android testing made the
 * case concretely: `powernap`'s lowest tone is 104 Hz at full scale, which buzzes on a phone's
 * micro-speaker, and the "bug" that was reported was really a programme being played the one way
 * it cannot be played.
 *
 * Shown before the first play rather than under the transport, because by the time someone has
 * pressed Play the advice has come too late to be worth anything.
 *
 * §2 forbids medical claims, so this says what the audio *is* and stops there.
 */
export function HeadphoneNotice({ onDismiss }: HeadphoneNoticeProps) {
  return (
    <aside className="headphones" role="note">
      <p className="headphones__body">
        <strong>Use headphones.</strong> A binaural beat is the difference your hearing constructs
        between a slightly different tone in each ear. Through a speaker both tones reach both ears,
        and the effect does not happen at all.
      </p>
      <button type="button" className="button" onClick={onDismiss}>
        Got it
      </button>
    </aside>
  );
}
