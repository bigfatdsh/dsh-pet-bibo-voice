/**
 * 哔哔啵啵（bibibobo）合成引擎 —— 宿主半侧。
 *
 * 直接移植自 hakihakii/bibibobo（MIT，哔哩哔哩「哈基科技 / Lumoswitch」《路墨小剧场》），
 * 只做三件事：清理不适合念的文本、按原算法合成单声道采样、封成 WAV。
 * 算法本身不改：一个字一声、同一个字永远同一个音高与口型、标点决定语气。
 *
 * 不依赖 dsh-pet：本文件可以在任何 Node 20+ 进程里独立跑、独立测。
 *
 * @module dsh-pet-bibo-voice/lib/bibo
 */

const TAU = Math.PI * 2;
const mtof = (m) => 440 * 2 ** ((m - 69) / 12);

/** 五种口型：每种只是两个共振峰频率（Hz）。 */
export const VOWELS = [
  [800, 1200],
  [400, 2200],
  [350, 800],
  [600, 1700],
  [300, 2600],
];

/**
 * 声线。字段含义与原仓库一致：
 * scale=音阶（MIDI 音高）、formant=共振峰倍率、maxDur=单字时长上限、
 * hold=时长占步长的比例、chirp=字头小滑音、fall=句尾默认滑音、gain=音量、step=默认字间隔。
 */
export const VOICES = {
  // 大肥鱼：E5 G5 A5 B5 C6
  fish: { scale: [76, 79, 81, 83, 84], formant: 1.25, maxDur: 0.13, hold: 0.8, chirp: 1.5, fall: 0, gain: 0.16, step: 0.13 },
  // 路墨：D4 E4 G4 A4
  lumo: { scale: [62, 64, 67, 69], formant: 0.9, maxDur: 0.2, hold: 0.7, chirp: 0, fall: -2, gain: 0.17, step: 0.16 },
};

/** 声线展示信息（宿主 provider 目录与设置页共用，保持一份）。 */
export const VOICE_LIST = [
  { id: 'fish', name: '大肥鱼', tag: '高音 · 活泼' },
  { id: 'lumo', name: '路墨', tag: '低音 · 冷淡' },
];

/** 同一个字永远得到同一个数，所以同一个字永远是同一声。 */
export const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.codePointAt(0)) % 9973, 7);

/** 一个汉字算一声，一串英文或数字算一声。 */
export const syllables = (s) => s.match(/[A-Za-z_/.0-9]+|[\u4e00-\u9fff]/g) ?? [];

/** 抗混叠锯齿波（polyBLEP）。 */
function saw(sampleRate) {
  let ph = 0;
  return (f) => {
    const dt = f / sampleRate;
    ph += dt;
    if (ph >= 1) ph -= 1;
    let v = 2 * ph - 1;
    if (ph < dt) {
      const t = ph / dt;
      v -= t + t - t * t - 1;
    } else if (ph > 1 - dt) {
      const t = (ph - 1) / dt;
      v -= t * t + t + t + 1;
    }
    return v;
  };
}

/** 状态变量滤波器，取带通输出。 */
function bandpass(sampleRate) {
  let lp = 0;
  let bp = 0;
  return (x, fc, q) => {
    const f = 2 * Math.sin((Math.PI * Math.min(fc, sampleRate / 6)) / sampleRate);
    const hp = x - lp - bp / q;
    bp += f * hp;
    lp += f * bp;
    return bp;
  };
}

/** 把一声写进 out：音高 m，时长 dur 秒，glide 是结尾滑多少个半音，vowel 选口型。 */
export function voice(out, sampleRate, t, m, dur, v, glide = 0, vowel = 0) {
  const osc = saw(sampleRate);
  const f1 = bandpass(sampleRate);
  const f2 = bandpass(sampleRate);
  const [a, b] = VOWELS[vowel % VOWELS.length];
  const start = Math.floor(t * sampleRate);
  const n = Math.floor(dur * sampleRate);
  for (let i = 0; i < n && start + i < out.length; i++) {
    const x = i / sampleRate;
    // 滑音 + 字头小滑音 + 一点颤音
    const pitch = mtof(m + glide * (x / dur) + v.chirp * Math.exp(-x * 30)) * (1 + 0.012 * Math.sin(TAU * 6 * x));
    const s = osc(pitch);
    // 5 毫秒起音，25 毫秒收尾
    const env = Math.min(1, x * 200) * Math.min(1, (dur - x) * 40);
    out[start + i] += (f1(s, a * v.formant, 4) + 0.7 * f2(s, b * v.formant, 5)) * env * v.gain;
  }
}

/**
 * 把不适合念的内容从文本里去掉。
 *
 * 桌宠说的话来自模型，可能带 Markdown、代码、链接、表情符号；这些直接送进合成器会变成
 * 一串没意义的「哔」。只保留汉字、拉丁字母、数字与能表达语气的标点。
 *
 * @param {unknown} text - 原始文本。
 * @param {number} [limit] - 最多保留多少个字符（防止一句话合成几十秒）。
 * @returns {string} 可念文本；可能为空串。
 */
export function toSpeakable(text, limit = 220) {
  let s = String(text ?? '');
  // 代码块、行内代码、图片与链接：不念
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/`[^`]*`/g, ' ');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, ' $1 ');
  s = s.replace(/https?:\/\/\S+|www\.\S+/gi, ' ');
  // HTML / XML 片段与 Markdown 记号
  s = s.replace(/<[^>]{1,120}>/g, ' ');
  s = s.replace(/[*_~#>|]+/g, ' ');
  // 表情符号、零宽连接符、变体选择符
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '');
  // 只留下汉字、拉丁字母、数字与能表达语气的标点
  s = s.replace(/[^\p{Script=Han}A-Za-z0-9？！。，、；：…?!.,;:\-—\s]/gu, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > limit) s = s.slice(0, limit).trim();
  return s;
}

/**
 * 把一句话合成为单声道采样（Float32Array，范围 -1..1）。
 *
 * @param {string} text - 要说的话。问号结尾尾音上扬；带感叹号整句升高；省略号结尾整句压低、尾音下滑。
 * @param {{voice?: string|object, step?: number, sampleRate?: number, gap?: number, rate?: number}} [opts]
 *   voice 声线 id 或自定义参数对象；rate 为语速偏移百分比（0 = 原速，-10 = 慢 10%）。
 * @returns {Float32Array} 采样。
 */
export function synth(text, opts = {}) {
  const v = typeof opts.voice === 'object' && opts.voice !== null ? { ...VOICES.fish, ...opts.voice } : VOICES[opts.voice ?? 'fish'] ?? VOICES.fish;
  const sampleRate = opts.sampleRate ?? 44100;
  // 语速：rate=100 快一倍，rate=-50 慢到 2/3；限制在 0.35×..1.6× 之间，避免糊成一片或拉成长音。
  const rate = Number.isFinite(opts.rate) ? Math.max(-50, Math.min(100, opts.rate)) : 0;
  const speed = 1 / (1 + rate / 100);
  const step = (opts.step ?? v.step) * speed;
  // rate=0 时保持与原算法逐位一致（测试会拿原仓库对拍）。
  const gap = rate === 0 ? (opts.gap ?? 0.22) : (opts.gap ?? 0.22) * (0.8 + 0.2 * speed);
  // 按标点切成句子，每句各自套一条语气规则
  const sentences = (text.match(/[^？?！!。.，,、；;…\n]+[？?！!。.，,、；;…]*/g) ?? [])
    .map((s) => ({ text: s, tk: syllables(s) }))
    .filter((s) => s.tk.length);
  const total = sentences.reduce((n, s) => n + s.tk.length * step + gap, 0) + 0.4;
  const out = new Float32Array(Math.ceil(total * sampleRate));
  let t = 0.02;
  for (const { text: s, tk } of sentences) {
    const ask = /[？?]$/.test(s);
    const shout = /[！!]/.test(s);
    const sad = /(……|\.\.\.|…)$/.test(s);
    tk.forEach((w, i) => {
      const last = i === tk.length - 1;
      const m = v.scale[hash(w) % v.scale.length] + (shout ? 3 : 0) - (sad ? 3 : 0);
      // 语速放慢时单字也跟着延长，否则会变成一串短促的「哔、哔、哔」。
      const dur = Math.min(step * v.hold, v.maxDur * speed) + (last && (ask || shout || sad) ? 0.1 : 0);
      voice(out, sampleRate, t + i * step, m, dur, v, last && ask ? 5 : last && sad ? -4 : last ? v.fall : 0, hash(w));
    });
    t += tk.length * step + gap;
  }
  // 软限幅，响一点也不破音
  for (let i = 0; i < out.length; i++) out[i] = Math.tanh(out[i] * 2.4);
  return out;
}

/**
 * 把采样封成 44.1kHz / 16-bit / 单声道 WAV。
 *
 * @param {Float32Array} samples - 采样。
 * @param {number} [sampleRate] - 采样率。
 * @returns {Uint8Array} 完整 WAV 字节。
 */
export function toWav(samples, sampleRate = 44100) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const d = new DataView(buf);
  const str = (o, s) => {
    for (let i = 0; i < s.length; i++) d.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  d.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  d.setUint32(16, 16, true);
  d.setUint16(20, 1, true);
  d.setUint16(22, 1, true);
  d.setUint32(24, sampleRate, true);
  d.setUint32(28, sampleRate * 2, true);
  d.setUint16(32, 2, true);
  d.setUint16(34, 16, true);
  str(36, 'data');
  d.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    d.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
  }
  return new Uint8Array(buf);
}

/**
 * 一站式：清理文本 → 合成 → 封装。
 *
 * @param {string} text - 原始文本。
 * @param {{voice?: string, rate?: number, limit?: number}} [opts] - 选项。
 * @returns {{wav: Uint8Array, samples: Float32Array, text: string, sampleRate: number}}
 * @throws {Error} 清理后没有可念内容时抛错（宿主会把它归成一次失败的合成，不写缓存）。
 */
export function synthesize(text, opts = {}) {
  const spoken = toSpeakable(text, opts.limit);
  if (!spoken) throw new Error('没有可念的内容');
  const sampleRate = 44100;
  const samples = synth(spoken, { voice: opts.voice, rate: opts.rate, sampleRate });
  if (!samples.length) throw new Error('合成结果为空');
  return { wav: toWav(samples, sampleRate), samples, text: spoken, sampleRate };
}
