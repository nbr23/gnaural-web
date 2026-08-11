import { useCallback, useEffect, useRef, useState } from 'react';
import type { Schedule } from '../document/types';
import type { EngineDiagnostics } from '../engine/engine';
import { PlaybackEngine } from '../engine/engine';
import { SilentKeepalive } from './keepalive';

/**
 * How often the playhead readout is refreshed while playing.
 *
 * Not every frame. A twenty-minute programme moves the chart's playhead about a third of a pixel
 * per second, so 60 Hz buys nothing visible and costs a full React render each frame — enough
 * work on a phone to starve the audio thread and crackle. rAF still drives it, so a backgrounded
 * tab stops polling and the readout catches up on return.
 */
const CLOCK_INTERVAL_MS = 100;

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
  /**
   * Bumped by every play, pause, stop and seek, and by nothing else.
   *
   * `offset` moves 60 times a second and says nothing about *why*; this says the playhead was
   * moved deliberately. It is what `useMediaSession` publishes position on, so the OS is told
   * where the playhead jumped to without being told 60 times a second where it drifted to.
   */
  transport: number;
  voiceGates: VoiceGate[];
  /** What the device reports about its output. **Diagnostic only** — see `src/app/debug.ts`. */
  diagnostics(): EngineDiagnostics;
  play(): void;
  pause(): void;
  stop(): void;
  seek(offset: number): void;
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
 * inside a user gesture (§4.4). The silent keepalive that makes lock-screen controls appear is
 * owned the same way, and started in the same gesture.
 *
 * `masterGain` is a *controlled* input rather than state owned here: it is a persisted setting
 * (`useSettings`), and the engine is only its sink.
 */
export function usePlayer(schedule: Schedule | null, masterGain = 1): Player {
  const engineRef = useRef<PlaybackEngine | null>(null);
  const keepalive = useRef(new SilentKeepalive());
  const [playing, setPlaying] = useState(false);
  const [offset, setOffset] = useState(0);
  const [duration, setDuration] = useState(0);
  const [transport, setTransport] = useState(0);
  const [voiceGates, setVoiceGates] = useState<VoiceGate[]>([]);

  const moved = useCallback(() => setTransport((count) => count + 1), []);

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

  // A new schedule tears down and rebuilds the graph; transport state resets with it. Navigating
  // to the library no longer clears the schedule, so this cleanup now runs only when the program
  // genuinely changes — and stopping the old one is exactly right then.
  useEffect(() => {
    if (!schedule) return;

    const instance = engine();
    instance.load(schedule);
    instance.setMasterGain(masterGainRef.current);
    setPlaying(false);
    setOffset(0);
    setDuration(instance.getDuration());
    setVoiceGates(readGates(instance, schedule));
    moved();

    return () => {
      instance.stop();
    };
  }, [schedule, engine, readGates, moved]);

  const silence = keepalive.current;
  useEffect(() => () => silence.dispose(), [silence]);

  // Only reaches the engine once one exists: before the first play there is no AudioContext to
  // apply a level to, and `load()` above already carries the current value in.
  useEffect(() => {
    engineRef.current?.setMasterGain(masterGain);
  }, [masterGain]);

  useEffect(() => {
    if (!playing) return;

    let frame = 0;
    let published = 0;

    const tick = (now: number) => {
      const instance = engineRef.current;
      if (instance && now - published >= CLOCK_INTERVAL_MS) {
        published = now;
        setOffset(instance.getCurrentOffset());
        if (instance.getDuration() > 0 && instance.getCurrentOffset() >= instance.getDuration()) {
          instance.stop();
          silence.stop();
          setPlaying(false);
          setOffset(0);
          moved();
          return;
        }
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, silence, moved]);

  const play = useCallback(() => {
    if (!schedule) return;
    const instance = engine();
    instance.play();
    // Inside the same gesture as the `AudioContext`, which is what both of them need (§4.4), and
    // after it, so the silence can be generated at the rate the output is actually running at.
    silence.start(instance.getSampleRate());
    setPlaying(true);
    moved();
  }, [engine, moved, schedule, silence]);

  const pause = useCallback(() => {
    engineRef.current?.pause();
    // The keepalive keeps running while paused: the media notification is the transport now, and
    // it has to survive a pause to be pressed again.
    setPlaying(false);
    setOffset(engineRef.current?.getCurrentOffset() ?? 0);
    moved();
  }, [moved]);

  const stop = useCallback(() => {
    engineRef.current?.stop();
    silence.stop();
    setPlaying(false);
    setOffset(0);
    moved();
  }, [moved, silence]);

  const seek = useCallback(
    (next: number) => {
      if (!schedule) return;
      const instance = engine();
      instance.seek(next);
      setOffset(instance.getCurrentOffset());
      moved();
    },
    [engine, moved, schedule],
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

  const diagnostics = useCallback(() => engine().getDiagnostics(), [engine]);

  return {
    playing,
    offset,
    duration,
    transport,
    voiceGates,
    diagnostics,
    play,
    pause,
    stop,
    seek,
    toggleMute,
    toggleSolo,
  };
}
