import { useCallback, useEffect, useRef, useState } from 'react';
import type { Schedule } from '../document/types';
import { PlaybackEngine } from '../engine/engine';

export interface VoiceGate {
  muted: boolean;
  soloed: boolean;
  audible: boolean;
}

export interface Player {
  playing: boolean;
  /** Current schedule-time offset in seconds, polled from the engine's own clock. */
  offset: number;
  duration: number;
  masterGain: number;
  voiceGates: VoiceGate[];
  play(): void;
  pause(): void;
  stop(): void;
  seek(offset: number): void;
  setMasterGain(value: number): void;
  toggleMute(index: number): void;
  toggleSolo(index: number): void;
}

/**
 * The single owner of a `PlaybackEngine` instance and of the `requestAnimationFrame` poll that
 * reads its clock.
 *
 * PLAN.md §4: the UI observes the engine's clock and never drives it. Nothing here schedules
 * audio on a JS timer — the whole schedule is already handed to the audio thread, so a
 * background tab that stops firing rAF keeps playing correctly and the readout simply catches up
 * when it returns. The end-of-schedule check below is likewise only syncing UI state: the audio
 * has already faded on its own scheduled ramp.
 *
 * The engine is constructed lazily on the first play, because `AudioContext` must be created
 * inside a user gesture (§4.4).
 */
export function usePlayer(schedule: Schedule | null): Player {
  const engineRef = useRef<PlaybackEngine | null>(null);
  const [playing, setPlaying] = useState(false);
  const [offset, setOffset] = useState(0);
  const [duration, setDuration] = useState(0);
  const [masterGain, setMasterGainState] = useState(1);
  const [voiceGates, setVoiceGates] = useState<VoiceGate[]>([]);

  const readGates = useCallback((engine: PlaybackEngine, of: Schedule): VoiceGate[] => {
    return of.voices.map((_voice, index) => ({
      muted: engine.isVoiceMuted(index),
      soloed: engine.isVoiceSoloed(index),
      audible: engine.isVoiceAudible(index),
    }));
  }, []);

  const engine = useCallback((): PlaybackEngine => {
    if (!engineRef.current) engineRef.current = new PlaybackEngine();
    return engineRef.current;
  }, []);

  // Read through a ref so the level carries across a schedule change without a change to it
  // re-triggering the load below.
  const masterGainRef = useRef(masterGain);
  masterGainRef.current = masterGain;

  // A new schedule tears down and rebuilds the graph; transport state resets with it. Leaving the
  // player (schedule becomes null) runs the cleanup, which stops playback rather than leaving a
  // program running with no visible transport.
  useEffect(() => {
    if (!schedule) return;

    const instance = engine();
    instance.load(schedule);
    instance.setMasterGain(masterGainRef.current);
    setPlaying(false);
    setOffset(0);
    setDuration(instance.getDuration());
    setVoiceGates(readGates(instance, schedule));

    return () => {
      instance.stop();
    };
  }, [schedule, engine, readGates]);

  useEffect(() => {
    if (!playing) return;

    let frame = 0;
    const tick = () => {
      const instance = engineRef.current;
      if (instance) {
        setOffset(instance.getCurrentOffset());
        if (instance.getDuration() > 0 && instance.getCurrentOffset() >= instance.getDuration()) {
          instance.stop();
          setPlaying(false);
          setOffset(0);
          return;
        }
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const play = useCallback(() => {
    if (!schedule) return;
    engine().play();
    setPlaying(true);
  }, [engine, schedule]);

  const pause = useCallback(() => {
    engineRef.current?.pause();
    setPlaying(false);
    setOffset(engineRef.current?.getCurrentOffset() ?? 0);
  }, []);

  const stop = useCallback(() => {
    engineRef.current?.stop();
    setPlaying(false);
    setOffset(0);
  }, []);

  const seek = useCallback(
    (next: number) => {
      if (!schedule) return;
      const instance = engine();
      instance.seek(next);
      setOffset(instance.getCurrentOffset());
    },
    [engine, schedule],
  );

  const setMasterGain = useCallback(
    (value: number) => {
      setMasterGainState(value);
      engine().setMasterGain(value);
    },
    [engine],
  );

  const toggleGate = useCallback(
    (index: number, apply: (instance: PlaybackEngine, gate: VoiceGate) => void) => {
      if (!schedule) return;
      const instance = engine();
      apply(instance, {
        muted: instance.isVoiceMuted(index),
        soloed: instance.isVoiceSoloed(index),
        audible: instance.isVoiceAudible(index),
      });
      setVoiceGates(readGates(instance, schedule));
    },
    [engine, readGates, schedule],
  );

  const toggleMute = useCallback(
    (index: number) => toggleGate(index, (i, gate) => i.setVoiceMuted(index, !gate.muted)),
    [toggleGate],
  );

  const toggleSolo = useCallback(
    (index: number) => toggleGate(index, (i, gate) => i.setVoiceSoloed(index, !gate.soloed)),
    [toggleGate],
  );

  return {
    playing,
    offset,
    duration,
    masterGain,
    voiceGates,
    play,
    pause,
    stop,
    seek,
    setMasterGain,
    toggleMute,
    toggleSolo,
  };
}
