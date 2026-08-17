import './HeadphoneNotice.css';

export interface HeadphoneNoticeProps {
  onDismiss: () => void;
}

/**
 * A binaural beat exists only between two ears; through a speaker both tones reach both ears and
 * it does not work at all. Shown before the first play, since the advice is useless once Play has
 * already been pressed.
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
