/**
 * Transport glyphs, drawn rather than typed: the media-control codepoints (U+23F8, U+23EA…) render
 * as colour emoji at their own size on Android/iOS, regardless of the text-presentation selector.
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

export function ImportIcon() {
  return (
    <Icon>
      <path d="M11 3h2v7.5h3.5L12 15.5 7.5 10.5H11z" />
      <path d="M4 14h2v5h12v-5h2v7H4z" />
    </Icon>
  );
}

export function PlusIcon() {
  return (
    <Icon>
      <path d="M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z" />
    </Icon>
  );
}

export function SlidersIcon() {
  return (
    <Icon>
      <path
        d="M3.5 8.5h17M3.5 15.5h17"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="9" cy="8.5" r="2.8" />
      <circle cx="15" cy="15.5" r="2.8" />
    </Icon>
  );
}

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
