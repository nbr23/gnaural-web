/**
 * Transport glyphs, drawn rather than typed.
 *
 * The media-control codepoints (U+23F8, U+23EA…) are the obvious alternative and the wrong one:
 * Android and iOS render most of them as colour emoji, at their own size, regardless of the
 * text-presentation selector. These are paths in `currentColor` at `1em`, so a transport button
 * looks like the rest of the app in both schemes and at any font size.
 *
 * Every icon is `aria-hidden`: the buttons in `src/player/Controls.tsx` carry the name.
 */

const BOX = 24;

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox={`0 0 ${BOX} ${BOX}`}
      width="1em"
      height="1em"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function PlayIcon() {
  return (
    <Icon>
      <path d="M8 5.2v13.6L19 12z" />
    </Icon>
  );
}

export function PauseIcon() {
  return (
    <Icon>
      <path d="M7 5h3.2v14H7zM13.8 5H17v14h-3.2z" />
    </Icon>
  );
}

export function StopIcon() {
  return (
    <Icon>
      <path d="M6.5 6.5h11v11h-11z" />
    </Icon>
  );
}

export function SeekBackIcon() {
  return (
    <Icon>
      <path d="M12 5.2v13.6L3 12zM21 5.2v13.6L12 12z" />
    </Icon>
  );
}

export function SeekForwardIcon() {
  return (
    <Icon>
      <path d="M12 5.2 21 12l-9 6.8zM3 5.2 12 12l-9 6.8z" />
    </Icon>
  );
}

/**
 * The two states of one control, so they share a cone and differ only to its right: the waves are
 * where the cross goes. Drawn to the same width either way, so a row of them does not shift when
 * one is toggled.
 */
const SPEAKER_CONE = 'M4 9.5h3.2L12 5.4v13.2L7.2 14.5H4z';

export function SpeakerOnIcon() {
  return (
    <Icon>
      <path d={SPEAKER_CONE} />
      <path
        d="M15.2 9a4.2 4.2 0 0 1 0 6M17.8 6.6a7.6 7.6 0 0 1 0 10.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </Icon>
  );
}

export function SpeakerOffIcon() {
  return (
    <Icon>
      <path d={SPEAKER_CONE} />
      <path
        d="M15.4 9.6 20.6 14.4M20.6 9.6 15.4 14.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </Icon>
  );
}
