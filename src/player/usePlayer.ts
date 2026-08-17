import { useCallback, useEffect, useRef, useState } from 'react';
import type { Schedule } from '../document/types';
import type { VoiceMap } from '../document/voiceMap';
import type { Horizon, NoiseLayerSettings } from '../engine/engine';
import { PlaybackEngine, SILENT_NOISE_LAYER } from '../engine/engine';
import { SilentKeepalive } from './keepalive';

/**
 * How often the playhead readout is refreshed while playing — not every frame. A twenty-minute
 * programme moves the chart's playhead about a third of a pixel per second, so 60 Hz buys nothing
 * visible and costs a full React render each frame, enough to starve the audio thread on a phone.
 */
const CLOCK_INTERVAL_MS = 100;

/**
 * How far one deliberate skip moves the playhead. Defined here rather than in a view because
 * three surfaces owe the same answer: the player's buttons, the lock-screen skip actions, and the
 * keyboard arrows.
 */
export const SEEK_STEP_SECONDS = 30;

export interface VoiceGate {
  muted: boolean;
  /** Derived by the engine, not stored: this voice is the only renderable one left unmuted. */
  soloed: boolean;
}

export interface Player {
  playing: boolean;
  /** Offset within the current pass, in seconds, polled from the engine's own clock. */
  offset: number;
  /** How long one pass lasts. A looping schedule replays the same duration, it does not extend it. */
  duration: number;
  /** Which pass is playing, counting from zero — 0 for everything that does not loop. */
  pass: number;
  passCount: number;
  /**
   * Bumped by every play, pause, stop and seek, and by nothing else. `offset` moves 60 times a
   * second and says nothing about *why*; this says the playhead was moved deliberately, and is
   * what `useMediaSession` publishes position on.
   */
  transport: number;
  voiceGates: VoiceGate[];
  play(): void;
  pause(): void;
  stop(): void;
  seek(offset: number): void;
  /**
   * Swap in an edited document without interrupting playback.
   *
   * The caller must keep the `schedule` argument to `usePlayer` identity-stable while using this
   * — the load effect below keys a teardown on that object, so pushing a new document through the
   * prop instead of here would rebuild the graph on every change.
   *
   * `horizon` is passed straight through; leave it out everywhere except a drag's throttled push
   * (see `PlaybackEngine.update`). `voiceMap` is required of a structural edit and nothing else —
   * without it the engine's session mute gates stay on the slots they were, which after a reorder
   * or delete is a different voice.
   */
  update(schedule: Schedule, horizon?: Horizon, voiceMap?: VoiceMap): void;
  /** Open the audio context inside a gesture that cannot `play()` until it has fetched something
   *  first. Nothing sounds. */
  prime(): void;
  toggleMute(index: number): void;
  toggleSolo(index: number): void;
}

/**
 * The single owner of a `PlaybackEngine` instance and of the `requestAnimationFrame` poll that
 * reads its clock.
 *
 * The UI observes the engine's clock and never drives it — nothing here schedules audio on a JS
 * timer, so a backgrounded tab that stops firing rAF keeps playing correctly and the readout
 * simply catches up when it returns.
 *
 * The engine is constructed lazily on the first play, since `AudioContext` must be created inside
 * a user gesture. The silent keepalive that makes lock-screen controls appear is owned the same
 * way, and started in the same gesture.
 *
 * `masterGain` and `noise` are controlled inputs rather than state owned here: both are persisted
 * settings, and the engine is only their sink.
 */
export function usePlayer(
  schedule: Schedule | null,
  masterGain = 1,
  noise: NoiseLayerSettings = SILENT_NOISE_LAYER,
): Player {
  const engineRef = useRef<PlaybackEngine | null>(null);
  const keepalive = useRef(new SilentKeepalive());
  const [playing, setPlaying] = useState(false);
  const [offset, setOffset] = useState(0);
  const [duration, setDuration] = useState(0);
  const [pass, setPass] = useState(0);
  const [passCount, setPassCount] = useState(1);
  const [transport, setTransport] = useState(0);
  const [voiceGates, setVoiceGates] = useState<VoiceGate[]>([]);

  const moved = useCallback(() => setTransport((count) => count + 1), []);

  const readGates = useCallback((engine: PlaybackEngine, of: Schedule): VoiceGate[] => {
    return of.voices.map((_voice, index) => ({
      muted: engine.isVoiceMuted(index),
      soloed: engine.isVoiceSoloed(index),
    }));
  }, []);

  const engine = useCallback((): PlaybackEngine => {
    if (!engineRef.current) engineRef.current = new PlaybackEngine();
    return engineRef.current;
  }, []);

  /**
   * The document the engine is actually holding, which after an edit is **not** the `schedule`
   * prop: a caller using `update` keeps that prop identity-stable, since the load effect below
   * keys a teardown on it. Anything derived per voice has to come from here, or a structural edit
   * that added a voice would lose it again the next time a gate was toggled.
   */
  const loaded = useRef(schedule);

  // Read through refs so the app's own levels carry across a schedule change without either
  // re-triggering the load below.
  const masterGainRef = useRef(masterGain);
  masterGainRef.current = masterGain;
  const noiseRef = useRef(noise);
  noiseRef.current = noise;

  // A new schedule tears down and rebuilds the graph; transport state resets with it.
  useEffect(() => {
    if (!schedule) return;

    const instance = engine();
    loaded.current = schedule;
    instance.load(schedule);
    instance.setMasterGain(masterGainRef.current);
    instance.setNoiseLayer(noiseRef.current);
    setPlaying(false);
    setOffset(0);
    setDuration(instance.getDuration());
    setPass(0);
    setPassCount(instance.getPassCount());
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

  // Same contract as master gain. Depends on the two values rather than the object, which the
  // caller is free to rebuild on every render.
  const { colour: noiseColour, gain: noiseGain } = noise;
  useEffect(() => {
    engineRef.current?.setNoiseLayer({ colour: noiseColour, gain: noiseGain });
  }, [noiseColour, noiseGain]);

  useEffect(() => {
    if (!playing) return;

    let frame = 0;
    let published = 0;

    const tick = (now: number) => {
      const instance = engineRef.current;
      if (instance && now - published >= CLOCK_INTERVAL_MS) {
        published = now;
        setOffset(instance.getCurrentOffset());
        setPass(instance.getPass());
        if (instance.hasEnded()) {
          instance.stop();
          silence.stop();
          setPlaying(false);
          setOffset(0);
          setPass(0);
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
    // The keepalive starts before the engine: the silent element is what claims audio focus, so
    // claiming it first is the right order for anything the engine then asks the platform for.
    // `prepare()` creates the context without scheduling, so the silence can be generated at the
    // rate the output actually runs at. All inside one gesture.
    instance.prepare();
    silence.start(instance.getSampleRate());
    instance.play();
    setPlaying(true);
    moved();
  }, [engine, moved, schedule, silence]);

  /**
   * Half of `play()`'s gesture work, for a caller that must load a program before starting it: a
   * context created after that await is one iOS refuses to run. The keepalive is deliberately not
   * started here — its `play` event is read as a transport intent below, which with nothing loaded
   * yet would resume whatever was playing before.
   */
  const prime = useCallback(() => {
    engine().prepare();
  }, [engine]);

  const pause = useCallback(() => {
    engineRef.current?.pause();
    // The keepalive pauses with the player. An element left running is media Chrome believes is
    // still playing, so its notification's play button has nothing to do — no state change, no
    // `play` event, no action handler. Ordered after `engine.pause()` so the resulting `pause`
    // event finds the engine already stopped and does nothing.
    silence.stop();
    setPlaying(false);
    setOffset(engineRef.current?.getCurrentOffset() ?? 0);
    moved();
  }, [moved, silence]);

  const stop = useCallback(() => {
    engineRef.current?.stop();
    silence.stop();
    setPlaying(false);
    setOffset(0);
    setPass(0);
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

  /**
   * Before the first play there is a `PlaybackEngine` but no `AudioContext`, so an edit made before
   * pressing Play is stored and simply becomes what plays.
   *
   * `duration` and `passCount` are re-read because an edit can change how long the schedule is.
   * `voiceGates` is re-read for the same reason: a structural edit changes how many there are and,
   * through `voiceMap`, which voice each one belongs to.
   */
  const update = useCallback(
    (next: Schedule, horizon?: Horizon, voiceMap?: VoiceMap) => {
      const instance = engineRef.current;
      if (!instance) return;
      loaded.current = next;
      instance.update(next, horizon, voiceMap);
      setDuration(instance.getDuration());
      setPassCount(instance.getPassCount());
      setVoiceGates(readGates(instance, next));
    },
    [readGates],
  );

  const toggleGate = useCallback(
    (index: number, apply: (instance: PlaybackEngine, gate: VoiceGate) => void) => {
      const current = loaded.current;
      if (!current) return;
      const instance = engine();
      apply(instance, {
        muted: instance.isVoiceMuted(index),
        soloed: instance.isVoiceSoloed(index),
      });
      setVoiceGates(readGates(instance, current));
    },
    [engine, readGates],
  );

  const toggleMute = useCallback(
    (index: number) => toggleGate(index, (i, gate) => i.setVoiceMuted(index, !gate.muted)),
    [toggleGate],
  );

  const toggleSolo = useCallback(
    (index: number) => toggleGate(index, (i, gate) => i.setVoiceSoloed(index, !gate.soloed)),
    [toggleGate],
  );

  /**
   * Follow the keepalive element's transport, which is what Android's notification actually
   * drives — whatever its buttons do, they do to this element, so observing it doesn't depend on
   * being told via `useMediaSession`'s handlers.
   *
   * Read through refs and guarded on the *engine's* own `isPlaying()` rather than React state:
   * these events fire for `play()`/`stop()`'s own calls too, and the engine's flag is set
   * synchronously, so a re-entrant call is a no-op instead of a loop.
   */
  const playRef = useRef(play);
  const pauseRef = useRef(pause);
  playRef.current = play;
  pauseRef.current = pause;

  useEffect(() => {
    silence.onPlatformPlay = () => {
      if (!engineRef.current?.isPlaying()) playRef.current();
    };
    silence.onPlatformPause = () => {
      if (engineRef.current?.isPlaying()) pauseRef.current();
    };

    return () => {
      silence.onPlatformPlay = null;
      silence.onPlatformPause = null;
    };
  }, [silence]);

  return {
    playing,
    offset,
    duration,
    pass,
    passCount,
    transport,
    voiceGates,
    play,
    pause,
    stop,
    seek,
    update,
    prime,
    toggleMute,
    toggleSolo,
  };
}
