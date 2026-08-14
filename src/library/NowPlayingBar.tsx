import { formatClock } from '../app/format';
import { PlayPauseButton, StopButton } from '../player/Controls';
import type { Player } from '../player/usePlayer';
import './NowPlayingBar.css';

export interface NowPlayingBarProps {
  title: string;
  player: Player;
  /**
   * Set for a session that runs until it is stopped. Live mode's document is a twelve-hour
   * container, which is true and says nothing anyone wants to read next to the elapsed time.
   */
  openEnded?: boolean;
  onOpen: () => void;
}

/**
 * What is playing, while you are somewhere else.
 *
 * Leaving the player used to stop the audio, on the grounds that a program running with no
 * visible transport is worse than an abrupt stop. Lock-screen controls retire that argument, and
 * this bar retires the rest of it: browsing the library for the next program should not
 * interrupt the current one.
 *
 * It observes the player like every other view — no audio node is touched here (PLAN.md §4).
 */
export function NowPlayingBar({ title, player, openEnded, onOpen }: NowPlayingBarProps) {
  return (
    <div className="now-playing">
      <button type="button" className="now-playing__open" onClick={onOpen}>
        <span className="now-playing__title">{title}</span>
        <span className="now-playing__time">
          {formatClock(player.offset)}
          {!openEnded && ` / ${formatClock(player.duration)}`}
        </span>
      </button>

      <PlayPauseButton
        playing={player.playing}
        onClick={() => (player.playing ? player.pause() : player.play())}
      />

      <StopButton onClick={player.stop} />
    </div>
  );
}
