import { formatClock } from '../app/format';
import type { Player } from '../player/usePlayer';
import './NowPlayingBar.css';

export interface NowPlayingBarProps {
  title: string;
  player: Player;
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
export function NowPlayingBar({ title, player, onOpen }: NowPlayingBarProps) {
  return (
    <div className="now-playing">
      <button type="button" className="now-playing__open" onClick={onOpen}>
        <span className="now-playing__title">{title}</span>
        <span className="now-playing__time">
          {formatClock(player.offset)} / {formatClock(player.duration)}
        </span>
      </button>

      <button
        type="button"
        className="button button--primary"
        onClick={() => (player.playing ? player.pause() : player.play())}
      >
        {player.playing ? 'Pause' : 'Play'}
      </button>

      <button type="button" className="button" onClick={player.stop}>
        Stop
      </button>
    </div>
  );
}
