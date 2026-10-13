import { useState, useEffect, useRef, useMemo } from 'react';
import {
  Play, Pause, SkipBack, SkipForward, Shuffle, Repeat,
  Sparkles, Cpu, Heart, Plus, Volume2, Layers, Dices, Activity
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const TRACKS = [
  {
    id: 1,
    title: 'Gradient Descent (Slow Bloom)',
    artist: 'Latent Choir',
    prompt: 'a cathedral of fog dissolving into peach light, hyperdetailed, volumetric, 35mm',
    seed: '4815162342',
    model: 'PRISM v4.1',
    steps: 50,
    duration: 263,
    img: 'https://images.unsplash.com/photo-1518837695005-2083093ee35b?w=1200&h=1200&fit=crop',
  },
  {
    id: 2,
    title: 'Noise Floor, Midnight',
    artist: 'Sampler & Scheduler',
    prompt: 'brutalist tower swallowed by bioluminescent moss, long exposure, deep navy hour',
    seed: '7700912384',
    model: 'PRISM v4.1',
    steps: 40,
    duration: 198,
    img: 'https://images.unsplash.com/photo-1470770841072-f978cf4d019e?w=1200&h=1200&fit=crop',
  },
  {
    id: 3,
    title: 'Checkpoint 88,000',
    artist: 'Ada & The Tensors',
    prompt: 'desert dunes rendered as silk fabric, golden hour, single wandering figure',
    seed: '1938475629',
    model: 'PRISM v4 turbo',
    steps: 28,
    duration: 244,
    img: 'https://images.unsplash.com/photo-1509316785289-025f5b846b35?w=1200&h=1200&fit=crop',
  },
  {
    id: 4,
    title: 'Upscale Lullaby',
    artist: 'Latent Choir',
    prompt: 'macro photograph of frost crystallizing on a violin string, prismatic refraction',
    seed: '6620118843',
    model: 'PRISM v4.1',
    steps: 50,
    duration: 312,
    img: 'https://images.unsplash.com/photo-1419242902214-272b3f66ee7a?w=1200&h=1200&fit=crop',
  },
  {
    id: 5,
    title: 'Negative Prompt Blues',
    artist: 'CFG=7',
    prompt: 'an empty diner at 3am, neon bleeding through rain, kodak portra 800 grain',
    seed: '0042001337',
    model: 'PRISM v3.9',
    steps: 35,
    duration: 187,
    img: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=1200&h=1200&fit=crop',
  },
  {
    id: 6,
    title: 'Seed Locked (For Mira)',
    artist: 'Sampler & Scheduler',
    prompt: 'thousands of paper cranes suspended in a flooded library, caustic light ripples',
    seed: '9090909090',
    model: 'PRISM v4.1',
    steps: 50,
    duration: 276,
    img: 'https://images.unsplash.com/photo-1507400492013-162706c8c05e?w=1200&h=1200&fit=crop',
  },
];

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export default function App() {
  const [activeId, setActiveId] = useState(1);
  const [playing, setPlaying] = useState(true);
  const [elapsed, setElapsed] = useState(74);
  const [liked, setLiked] = useState([1, 4]);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState(true);

  const track = useMemo(() => TRACKS.find((t) => t.id === activeId), [activeId]);
  const idx = TRACKS.findIndex((t) => t.id === activeId);

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      setElapsed((e) => {
        if (e + 1 >= track.duration) {
          const next = TRACKS[(idx + 1) % TRACKS.length].id;
          setActiveId(next);
          return 0;
        }
        return e + 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [playing, track, idx]);

  const selectTrack = (id) => {
    setActiveId(id);
    setElapsed(0);
    setPlaying(true);
  };

  const skip = (dir) => {
    const next = TRACKS[(idx + dir + TRACKS.length) % TRACKS.length].id;
    selectTrack(next);
  };

  const toggleLike = (id) =>
    setLiked((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));

  const pct = (elapsed / track.duration) * 100;
  const denoised = Math.round((elapsed / track.duration) * track.steps);

  const bars = useMemo(() => Array.from({ length: 28 }, (_, i) => i), []);

  return (
    <div className="lfm-root min-h-screen bg-[#0d0b08] text-[#ece5d8] antialiased flex flex-col overflow-hidden">
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link
        href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Space+Grotesk:wght@300;400;500;600&family=JetBrains+Mono:wght@300;400;500&display=swap"
        rel="stylesheet"
      />
      <style
        dangerouslySetInnerHTML={{
          __html: `
        .lfm-root { font-family: 'Space Grotesk', sans-serif; }
        .serif { font-family: 'Instrument Serif', serif; }
        .mono { font-family: 'JetBrains Mono', monospace; }
        .grain::after {
          content: ''; position: absolute; inset: 0; pointer-events: none; opacity: .5; mix-blend-mode: overlay;
          background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.35'/%3E%3C/svg%3E");
        }
        @keyframes eq {
          0%, 100% { transform: scaleY(0.25); }
          50% { transform: scaleY(1); }
        }
        .eqbar { transform-origin: bottom; animation: eq 1.1s ease-in-out infinite; }
        .eqbar.paused { animation-play-state: paused; transform: scaleY(0.18); }
        @keyframes drift { from { background-position: 0 0; } to { background-position: 200px 200px; } }
        .queue-scroll::-webkit-scrollbar { width: 4px; }
        .queue-scroll::-webkit-scrollbar-track { background: transparent; }
        .queue-scroll::-webkit-scrollbar-thumb { background: #2c261c; border-radius: 99px; }
        .scrub { -webkit-appearance: none; appearance: none; background: transparent; cursor: pointer; }
        .scrub::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; border-radius: 0; background: #ff4d00; transform: rotate(45deg); box-shadow: 0 0 0 4px rgba(255,77,0,.18); }
        .scrub::-moz-range-thumb { width: 12px; height: 12px; border-radius: 0; border: none; background: #ff4d00; }
      `,
        }}
      />

      {/* ───── Top bar ───── */}
      <header className="flex items-center justify-between px-7 py-4 border-b border-[#221d15]">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 bg-[#ff4d00] flex items-center justify-center rotate-45">
            <Sparkles size={13} className="-rotate-45 text-[#0d0b08]" strokeWidth={2.5} />
          </div>
          <div className="leading-none">
            <span className="serif text-xl tracking-tight">latent.fm</span>
            <span className="mono text-[10px] text-[#7a6f5c] ml-2 tracking-widest uppercase">by Prism Labs</span>
          </div>
        </div>
        <div className="hidden md:flex items-center gap-6 mono text-[10px] tracking-widest text-[#7a6f5c] uppercase">
          <span className="flex items-center gap-2">
            <Cpu size={12} className="text-[#ff4d00]" /> A100 cluster · 12 renders queued
          </span>
          <span className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-[#7fd068] animate-pulse" /> Studio session live
          </span>
        </div>
        <button className="mono text-[10px] tracking-widest uppercase border border-[#3a3225] hover:border-[#ff4d00] hover:text-[#ff4d00] transition-colors px-4 py-2">
          New render →
        </button>
      </header>

      {/* ───── Main ───── */}
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-[1.15fr_1fr] gap-0 min-h-0">
        {/* Now generating / playing */}
        <section className="relative border-r border-[#221d15] flex flex-col">
          <div className="px-7 pt-6 pb-4 flex items-baseline justify-between">
            <p className="mono text-[10px] tracking-[0.25em] uppercase text-[#7a6f5c]">
              Now diffusing — Track {String(idx + 1).padStart(2, '0')} / {String(TRACKS.length).padStart(2, '0')}
            </p>
            <p className="mono text-[10px] text-[#ff4d00]">
              step {denoised}/{track.steps}
            </p>
          </div>

          <div className="px-7 flex-1 min-h-0 flex flex-col">
            {/* Artwork */}
            <div className="relative grain overflow-hidden aspect-[16/10] lg:aspect-auto lg:flex-1 min-h-[260px]">
              <AnimatePresence mode="wait">
                <motion.img
                  key={track.id}
                  src={track.img}
                  alt={track.title}
                  initial={{ opacity: 0, filter: 'blur(28px) saturate(0.4)', scale: 1.06 }}
                  animate={{ opacity: 1, filter: 'blur(0px) saturate(1)', scale: 1 }}
                  exit={{ opacity: 0, filter: 'blur(18px)', scale: 0.98 }}
                  transition={{ duration: 1.4, ease: [0.22, 1, 0.36, 1] }}
                  className="absolute inset-0 w-full h-full object-cover"
                />
              </AnimatePresence>
              <div className="absolute inset-0 bg-gradient-to-t from-[#0d0b08] via-transparent to-transparent opacity-90" />

              {/* corner ticks */}
              {['top-3 left-3 border-t border-l', 'top-3 right-3 border-t border-r', 'bottom-3 left-3 border-b border-l', 'bottom-3 right-3 border-b border-r'].map((c) => (
                <div key={c} className={`absolute w-5 h-5 border-[#ece5d8]/60 ${c}`} />
              ))}

              {/* metadata chip */}
              <div className="absolute top-5 left-7 mono text-[9px] tracking-widest uppercase bg-[#0d0b08]/70 backdrop-blur-sm px-2.5 py-1.5 border border-[#ece5d8]/15 flex items-center gap-2">
                <Layers size={10} className="text-[#ff4d00]" />
                {track.model} · seed {track.seed}
              </div>

              {/* eq bars */}
              <div className="absolute bottom-5 right-7 flex items-end gap-[3px] h-8">
                {bars.slice(0, 14).map((b) => (
                  <div
                    key={b}
                    className={`eqbar w-[3px] bg-[#ff4d00] ${playing ? '' : 'paused'}`}
                    style={{ height: `${30 + ((b * 37) % 70)}%`, animationDelay: `${b * 0.09}s`, animationDuration: `${0.8 + (b % 5) * 0.13}s` }}
                  />
                ))}
              </div>

              {/* title block */}
              <div className="absolute bottom-0 left-0 right-0 px-7 pb-6">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={track.id}
                    initial={{ y: 18, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: -10, opacity: 0 }}
                    transition={{ duration: 0.5, ease: 'easeOut' }}
                  >
                    <h1 className="serif text-4xl md:text-5xl leading-[1.02] tracking-tight">
                      {track.title}
                    </h1>
                    <p className="mt-2 text-sm text-[#cdc4b2] font-light">{track.artist}</p>
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>

            {/* Prompt as lyrics */}
            <div className="py-5 flex items-start gap-4">
              <span className="mono text-[9px] tracking-[0.25em] uppercase text-[#7a6f5c] mt-1 shrink-0">prompt</span>
              <p className="mono text-[13px] leading-relaxed text-[#b9ae98]">
                <span className="text-[#ff4d00]">/imagine</span> {track.prompt}{' '}
                <span className="text-[#564d3d]">--ar 1:1 --steps {track.steps} --seed {track.seed}</span>
              </p>
            </div>
          </div>
        </section>

        {/* Queue */}
        <section className="flex flex-col min-h-0">
          <div className="px-7 pt-6 pb-3 flex items-center justify-between">
            <div>
              <h2 className="serif text-2xl italic">Render Queue</h2>
              <p className="mono text-[10px] tracking-widest uppercase text-[#7a6f5c] mt-1">
                Soundscapes generated alongside your batch · 24 min total
              </p>
            </div>
            <button className="flex items-center gap-1.5 mono text-[10px] tracking-widest uppercase text-[#7a6f5c] hover:text-[#ece5d8] transition-colors">
              <Plus size={12} /> Add
            </button>
          </div>

          <div className="queue-scroll flex-1 overflow-y-auto px-4 pb-4">
            {TRACKS.map((t, i) => {
              const active = t.id === activeId;
              return (
                <button
                  key={t.id}
                  onClick={() => selectTrack(t.id)}
                  className={`group w-full text-left flex items-center gap-4 px-3 py-3 border-b border-[#1c1812] transition-colors ${
                    active ? 'bg-[#17130d]' : 'hover:bg-[#13100b]'
                  }`}
                >
                  <span className={`mono text-[10px] w-5 ${active ? 'text-[#ff4d00]' : 'text-[#564d3d]'}`}>
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <div className="relative w-12 h-12 shrink-0 overflow-hidden">
                    <img src={t.img} alt="" className="w-full h-full object-cover" />
                    {active && (
                      <div className="absolute inset-0 bg-[#0d0b08]/55 flex items-center justify-center">
                        <div className="flex items-end gap-[2px] h-4">
                          {[0, 1, 2].map((b) => (
                            <div key={b} className={`eqbar w-[2.5px] bg-[#ff4d00] ${playing ? '' : 'paused'}`}
                              style={{ height: '100%', animationDelay: `${b * 0.15}s` }} />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm truncate ${active ? 'text-[#ece5d8]' : 'text-[#cdc4b2]'} group-hover:text-[#ece5d8] transition-colors`}>
                      {t.title}
                    </p>
                    <p className="mono text-[10px] text-[#7a6f5c] truncate mt-0.5">
                      {t.artist} · {t.model}
                    </p>
                  </div>
                  <div className="hidden sm:flex items-center gap-1.5 mono text-[9px] text-[#564d3d]">
                    <Dices size={10} /> {t.seed.slice(0, 6)}…
                  </div>
                  <span
                    onClick={(e) => { e.stopPropagation(); toggleLike(t.id); }}
                    className="p-1 cursor-pointer"
                  >
                    <Heart
                      size={14}
                      className={liked.includes(t.id) ? 'text-[#ff4d00] fill-[#ff4d00]' : 'text-[#564d3d] hover:text-[#cdc4b2] transition-colors'}
                    />
                  </span>
                  <span className="mono text-[10px] text-[#7a6f5c] w-9 text-right">{fmt(t.duration)}</span>
                </button>
              );
            })}

            {/* footnote card */}
            <div className="mt-4 mx-3 border border-dashed border-[#2c261c] p-4 flex items-start gap-3">
              <Activity size={14} className="text-[#ff4d00] mt-0.5 shrink-0" />
              <p className="mono text-[10px] leading-relaxed text-[#7a6f5c]">
                Each track is composed by PRISM Audio in real time, conditioned on the latent noise of the image
                you're generating. Same seed, same song — lock it to keep the vibe.
              </p>
            </div>
          </div>
        </section>
      </main>

      {/* ───── Player bar ───── */}
      <footer className="border-t border-[#221d15] bg-[#0a0806] px-7 py-4">
        {/* scrubber */}
        <div className="flex items-center gap-4 mb-3">
          <span className="mono text-[10px] text-[#7a6f5c] w-10">{fmt(elapsed)}</span>
          <div className="relative flex-1 h-3 flex items-center group">
            {/* step ticks */}
            <div className="absolute inset-x-0 flex justify-between pointer-events-none">
              {Array.from({ length: 41 }).map((_, i) => (
                <span key={i} className={`w-px h-[7px] ${i / 40 <= pct / 100 ? 'bg-[#ff4d00]/70' : 'bg-[#2c261c]'}`} />
              ))}
            </div>
            <div className="absolute inset-x-0 h-px bg-[#2c261c]" />
            <div className="absolute h-px bg-[#ff4d00]" style={{ width: `${pct}%` }} />
            <input
              type="range"
              min={0}
              max={track.duration}
              value={elapsed}
              onChange={(e) => setElapsed(Number(e.target.value))}
              className="scrub absolute inset-0 w-full opacity-0 group-hover:opacity-100 transition-opacity"
            />
            <div
              className="absolute w-2 h-2 bg-[#ff4d00] rotate-45 -translate-x-1/2 shadow-[0_0_0_4px_rgba(255,77,0,0.15)]"
              style={{ left: `${pct}%` }}
            />
          </div>
          <span className="mono text-[10px] text-[#7a6f5c] w-10 text-right">{fmt(track.duration)}</span>
        </div>

        <div className="flex items-center justify-between">
          {/* mini track */}
          <div className="hidden md:flex items-center gap-3 w-72">
            <img src={track.img} alt="" className="w-10 h-10 object-cover" />
            <div className="min-w-0">
              <p className="text-sm truncate">{track.title}</p>
              <p className="mono text-[9px] text-[#7a6f5c] truncate uppercase tracking-widest">{track.artist}</p>
            </div>
          </div>

          {/* transport */}
          <div className="flex items-center gap-5 mx-auto md:mx-0">
            <button onClick={() => setShuffle(!shuffle)} className={`transition-colors ${shuffle ? 'text-[#ff4d00]' : 'text-[#7a6f5c] hover:text-[#ece5d8]'}`}>
              <Shuffle size={16} />
            </button>
            <button onClick={() => skip(-1)} className="text-[#cdc4b2] hover:text-[#ece5d8] transition-colors">
              <SkipBack size={20} />
            </button>
            <motion.button
              whileTap={{ scale: 0.92 }}
              onClick={() => setPlaying(!playing)}
              className="w-12 h-12 bg-[#ece5d8] text-[#0d0b08] flex items-center justify-center hover:bg-[#ff4d00] hover:text-[#0d0b08] transition-colors"
              style={{ borderRadius: '2px' }}
            >
              {playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" className="ml-0.5" />}
            </motion.button>
            <button onClick={() => skip(1)} className="text-[#cdc4b2] hover:text-[#ece5d8] transition-colors">
              <SkipForward size={20} />
            </button>
            <button onClick={() => setRepeat(!repeat)} className={`transition-colors ${repeat ? 'text-[#ff4d00]' : 'text-[#7a6f5c] hover:text-[#ece5d8]'}`}>
              <Repeat size={16} />
            </button>
          </div>

          {/* right cluster */}
          <div className="hidden md:flex items-center gap-4 w-72 justify-end">
            <span className="mono text-[9px] tracking-widest uppercase text-[#564d3d]">cfg 7.0 · 44.1kHz</span>
            <Volume2 size={16} className="text-[#7a6f5c]" />
            <div className="w-20 h-px bg-[#2c261c] relative">
              <div className="absolute inset-y-0 left-0 w-3/4 h-px bg-[#cdc4b2]" />
              <div className="absolute w-1.5 h-1.5 bg-[#cdc4b2] rotate-45 -top-[3px]" style={{ left: '75%' }} />
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}