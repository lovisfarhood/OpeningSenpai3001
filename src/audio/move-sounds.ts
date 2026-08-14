type AudioContextConstructor = new () => AudioContext;

let context: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const constructor = window.AudioContext ?? (window as typeof window & {
    webkitAudioContext?: AudioContextConstructor;
  }).webkitAudioContext;
  if (!constructor) return null;
  context ??= new constructor();
  return context;
}

/** Tiny synthesized feedback; no downloaded or third-party sound asset is used. */
export function playMoveSound(capture: boolean): void {
  const audio = audioContext();
  if (!audio) return;
  void audio.resume().then(() => {
    const now = audio.currentTime;
    const gain = audio.createGain();
    const oscillator = audio.createOscillator();
    oscillator.type = capture ? 'square' : 'sine';
    oscillator.frequency.setValueAtTime(capture ? 150 : 330, now);
    oscillator.frequency.exponentialRampToValueAtTime(capture ? 95 : 245, now + .055);
    gain.gain.setValueAtTime(.0001, now);
    gain.gain.exponentialRampToValueAtTime(capture ? .075 : .045, now + .006);
    gain.gain.exponentialRampToValueAtTime(.0001, now + (capture ? .085 : .06));
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start(now);
    oscillator.stop(now + (capture ? .09 : .065));
  }).catch(() => {
    // Autoplay policy or unavailable audio must never interrupt a chess move.
  });
}
