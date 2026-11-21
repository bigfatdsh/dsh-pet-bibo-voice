/**
 * 浏览器半侧：把 dsh-pet 的语音配置接到「哔哔啵啵」上，并提供设置页。
 *
 * 职责边界（为什么这样切）：
 *   - 合成与播放都是 dsh-pet 自己的链路：它按 `say` 叶子决定念哪一句，在正确的表面
 *     （网页 / 桌面 Helper / 独立模式）播放。我们只把它的语音实现指到 bibo，并确保
 *     两个开关与音色长期保持在正确值上。
 *   - 因此这里不碰气泡 DOM、不解析动画、不复制状态轮询；dsh-pet 更新内部渲染时本插件无感。
 *   - 唯一依赖的对外面是 `GET/PUT /config`（它自己的设置页用的同一套）与
 *     `petApi7340.voice.register`（宿主侧）。
 *
 * 更新不失效：
 *   1. 配置读写全部走 HTTP，不 import dsh-pet 模块；
 *   2. 每次对账前重新 GET：字段缺失、形状不认识就只提示不写；
 *   3. 定时自愈：设置被 dsh-pet 设置页或别处改掉，20 秒内会重新接管；
 *   4. 失败降级：读不到配置 / 引擎没接入时只显示状态，不抛错、不影响桌宠。
 *
 * 本文件是普通副作用脚本（不是 ESM），由构建器直接提供给页面的模块加载器。
 * @module dsh-pet-bibo-voice/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-pet-bibo-voice',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const VERSION = '0.1.1';
    const NS = 'pet-bibo-voice';
    const LOCAL_KEY = 'dsh-pet-bibo-voice:settings:v1';
    const ROUTE_SEGMENT = '/dsh-pet-bibo-voice';
    const PET_SEGMENT = '/dsh-pet-7340';
    const RECONCILE_MS = 20000;
    // 页面/系统睡了很久之后再回来：dsh-pet 的桌面 Helper 可能把睡眠期间攒下的音频
    // 一起放出来。超过这个间隔就视为「睡醒」，主动重启一次 Helper 清空队列。
    const WAKE_GAP_MS = 20 * 60 * 1000;

    const log = (...args) => {
      try {
        console.info('[dsh-pet-bibo-voice]', ...args);
      } catch {
        /* 控制台不可用无所谓 */
      }
    };

    // ---------------------------------------------------------------- 设置（localStorage）
    const DEFAULT_SETTINGS = {
      enabled: true,
      voice: 'fish',
      volume: 0.8,
      userDisabled: false,
      snapshot: null,
      lastWriteAt: 0,
      welcomed: false,
      welcomeTries: 0,
      seenSuppressed: 0,
    };

    function normalizeSettings(raw) {
      const o = raw && typeof raw === 'object' ? raw : {};
      const voice = o.voice === 'lumo' ? 'lumo' : 'fish';
      const volume = Number(o.volume);
      return {
        enabled: o.enabled !== false,
        voice,
        volume: Number.isFinite(volume) ? Math.min(1, Math.max(0.05, volume)) : DEFAULT_SETTINGS.volume,
        userDisabled: o.userDisabled === true,
        snapshot: o.snapshot && typeof o.snapshot === 'object' ? o.snapshot : null,
        lastWriteAt: Number.isFinite(Number(o.lastWriteAt)) ? Number(o.lastWriteAt) : 0,
        welcomed: o.welcomed === true,
        welcomeTries: Number.isFinite(Number(o.welcomeTries)) ? Math.max(0, Math.min(10, Number(o.welcomeTries))) : 0,
        seenSuppressed: Number.isFinite(Number(o.seenSuppressed)) ? Math.max(0, Number(o.seenSuppressed)) : 0,
      };
    }

    let settings = readSettings();
    /** 欢迎语正在发：并发的两个对账（boot + visible）不能各说一遍。 */
    let welcomeInFlight = false;

    function readSettings() {
      try {
        const raw = window.localStorage.getItem(LOCAL_KEY);
        return normalizeSettings(raw ? JSON.parse(raw) : null);
      } catch {
        return { ...DEFAULT_SETTINGS };
      }
    }

    function saveSettings(patch) {
      settings = normalizeSettings({ ...settings, ...patch });
      try {
        window.localStorage.setItem(LOCAL_KEY, JSON.stringify(settings));
      } catch {
        /* 隐私模式 / 配额满：只影响持久化 */
      }
      return settings;
    }

    // ---------------------------------------------------------------- 地址与 HTTP
    function mountPrefixOf(baseURI) {
      try {
        const url = new URL(baseURI);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
        return url.pathname.replace(/\/+$/, '');
      } catch {
        return '';
      }
    }

    const mountPrefix = () => (typeof document === 'undefined' ? '' : mountPrefixOf(document.baseURI));
    const petBase = () => mountPrefix() + PET_SEGMENT;
    const selfBase = () => mountPrefix() + ROUTE_SEGMENT;

    async function request(url, init = {}, timeoutMs = 9000) {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init, signal: controller.signal });
      } finally {
        window.clearTimeout(timer);
      }
    }

    async function getJson(url, timeoutMs) {
      const res = await request(url, { headers: { accept: 'application/json' } }, timeoutMs);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }

    /** dsh-pet 的成品配置（GET /config）：{ main: { pets, voiceEnabled, ... }, ...pack }。 */
    async function getPetConfig() {
      const body = await getJson(petBase() + '/config');
      if (!body || typeof body !== 'object' || !body.main || typeof body.main !== 'object') {
        throw new Error('dsh-pet /config 形状不认识（可能更新了大版本）');
      }
      return body;
    }

    /** 写 dsh-pet 用户层配置（PUT /config；它自己的设置页用同一个端点）。 */
    async function putPetConfig(payload) {
      const res = await request(
        petBase() + '/config',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        },
        15000,
      );
      let body = null;
      try {
        body = await res.json();
      } catch {
        /* 非 JSON 失败体 */
      }
      if (!res.ok) throw new Error(`PUT /config HTTP ${res.status}`);
      if (body && body.ok === false) throw new Error(String(body.message || body.reason || '保存失败'));
      return body;
    }

    /** 本插件宿主侧的状态：引擎有没有接进 dsh-pet。 */
    /** 把一行诊断写到宿主日志（失败静默）：排障时能确认浏览器半侧到底有没有跑起来。 */
    function clientLog(message) {
      try {
        void fetch(selfBase() + '/client-log', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: String(message ?? '').slice(0, 600) }),
        }).catch(() => {});
      } catch {
        /* 网络不可用不影响主流程 */
      }
    }

    async function getEngineStatus() {
      try {
        const body = await getJson(selfBase() + '/status', 5000);
        return body && typeof body === 'object' ? body : null;
      } catch {
        return null;
      }
    }

    // ---------------------------------------------------------------- 运行时状态
    const runtime = {
      version: VERSION,
      lastAt: 0,
      busy: false,
      engine: null,
      providerReady: false,
      petConfig: null,
      managed: false,
      managedVoice: '',
      note: '正在连接 dsh-pet…',
      error: '',
      lastAction: '',
      listeners: new Set(),
    };

    function emit() {
      for (const fn of [...runtime.listeners]) {
        try {
          fn();
        } catch {
          /* 一个订阅者抛错不影响别的 */
        }
      }
    }

    function sleep(ms) {
      return new Promise((resolve) => window.setTimeout(resolve, ms));
    }

    // ---------------------------------------------------------------- 接管 / 还原
    function voiceFlagsOn(main) {
      return main?.voiceEnabled === true || main?.voiceWhisperEnabled === true;
    }

    function isBiboName(name) {
      return typeof name === 'string' && name.startsWith('bibo/');
    }

    function petsWritable(main) {
      const pets = main?.pets;
      if (!Array.isArray(pets) || pets.length === 0) return false;
      return pets.every(
        (pet) =>
          pet &&
          typeof pet === 'object' &&
          typeof pet.id === 'string' &&
          pet.id.trim() !== '' &&
          pet.position &&
          typeof pet.position === 'object',
      );
    }

    function snapshotOf(main) {
      return {
        voiceEnabled: main.voiceEnabled === true,
        voiceWhisperEnabled: main.voiceWhisperEnabled === true,
        voiceName: typeof main.voiceName === 'string' ? main.voiceName : '',
        voiceVolume: Number.isFinite(Number(main.voiceVolume)) ? Number(main.voiceVolume) : 1,
      };
    }

    function takeoverPayload(main, voice) {
      return {
        // pets 必须整包提交：PUT /config 是白名单重建，缺 pets 会被判非法。
        pets: main.pets,
        voiceEnabled: true,
        voiceWhisperEnabled: true,
        voiceName: 'bibo/' + voice,
        voiceVolume: settings.volume,
      };
    }

    /**
     * 接管成功后的第一声：借 dsh-pet 自己的 /broadcast（第三方投喂 + speak:true）说一句。
     * 这样装完就能听见，而且这句话和桌宠平时的说话走完全相同的一条链路——是端到端自检，
     * 不是本插件另开一条音频通道。失败不重试太多次，避免反复打扰。
     */
    async function welcome(main) {
      if (settings.welcomed || welcomeInFlight) return;
      if (settings.welcomeTries >= 10) {
        clientLog('welcome skipped: tried 10 times');
        return;
      }
      const list = Array.isArray(main?.pets) ? main.pets : [];
      const pet = list.find((p) => p && p.display && p.display !== 'none') || list[0] || null;
      if (!pet || typeof pet.id !== 'string') return;
      welcomeInFlight = true;
      if (pet.display === 'none') {
        saveSettings({ welcomed: true });
        welcomeInFlight = false;
        return;
      }
      // dsh-pet 的 ?surface= 是必填的（缺省会被判 bad-request）：桌面优先，网页模式才用 web。
      const surface = pet.display === 'web' ? 'web' : 'desktop';
      await sleep(1500);
      const url =
        petBase() +
        '/broadcast?pet=' +
        encodeURIComponent(pet.id) +
        '&surface=' +
        encodeURIComponent(surface);
      let body = null;
      try {
        const res = await request(
          url,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: '哔哔啵啵，听得到吗？', speak: true, duration: 4000 }),
          },
          15000,
        );
        body = await res.json().catch(() => null);
      } catch (error) {
        body = { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
      saveSettings({ welcomeTries: settings.welcomeTries + 1 });
      welcomeInFlight = false;
      if (body && body.ok === true) {
        saveSettings({ welcomed: true });
        clientLog('welcome spoken');
      } else {
        clientLog(`welcome failed: ${(body && (body.reason || body.message)) || 'unknown'}`);
      }
    }

    async function takeover(main, voice, reason) {
      if (!petsWritable(main)) throw new Error('配置里的 pets 形状不认识，未写入（避免弄坏桌宠配置）');
      if (!settings.snapshot) saveSettings({ snapshot: snapshotOf(main) });
      const payload = takeoverPayload(main, voice);
      const result = await putPetConfig(payload);
      saveSettings({ lastWriteAt: Date.now() });
      runtime.lastAction = reason || '已接管';
      runtime.note = '已接管：桌宠会用哔哔啵啵说话';
      runtime.managed = true;
      runtime.managedVoice = voice;
      log('takeover', payload.voiceName, result ? 'ok' : 'no-body');
      // 不 await：它要等 Helper 重启后才会被读到，不能卡住对账。
      void welcome(main);
      return result;
    }

    async function restore(main) {
      if (!petsWritable(main)) throw new Error('配置里的 pets 形状不认识，未写入');
      const snap = settings.snapshot || {
        voiceEnabled: false,
        voiceWhisperEnabled: false,
        voiceName: '',
        voiceVolume: 1,
      };
      const payload = {
        pets: main.pets,
        voiceEnabled: snap.voiceEnabled === true,
        voiceWhisperEnabled: snap.voiceWhisperEnabled === true,
        voiceVolume: Number.isFinite(Number(snap.voiceVolume)) ? Number(snap.voiceVolume) : 1,
      };
      // 空字符串不是合法的 voiceName（config 校验只认 provider/voice 形态）：空着就保留现值。
      if (typeof snap.voiceName === 'string' && snap.voiceName.trim() !== '') payload.voiceName = snap.voiceName;
      await putPetConfig(payload);
      saveSettings({ lastWriteAt: Date.now() });
      runtime.lastAction = '已恢复原语音设置';
      runtime.note = '已停用，dsh-pet 的语音设置已恢复';
      runtime.managed = false;
      runtime.managedVoice = '';
      log('restored');
    }

    /**
     * 睡醒后的清队：把当前配置原样 PUT 一次。dsh-pet 的 PUT 会重启桌面 Helper，
     * Helper 进程里的 Audio 元素随之销毁——睡眠期间排进系统音频队列的那一串就不会再一起响。
     * 只在「合盖静音没有生效」（比如没合盖直接系统睡眠）时才需要。
     */
    async function flushAfterWake(main) {
      await putPetConfig(takeoverPayload(main, settings.voice));
      saveSettings({ lastWriteAt: Date.now() });
      runtime.note = '睡醒后已重启桌宠，清掉睡眠期间排队的音频';
      runtime.lastAction = '睡醒清队';
      clientLog('wake flush: helper restarted');
    }

    /**
     * 对账：读一次引擎状态 + dsh-pet 配置，决定是「接管」「保持」还是「让位」。
     *
     * 不自动抢占用户已经开着的别家语音：只有两种情况下会写入配置：
     *   1. 当前 voiceName 已经是 bibo/*（接管过，保证音色与开关同步）；
     *   2. 两个语音开关都没开（用户本来就没在用语音，本插件负责打开）。
     */
    async function reconcile(reason) {
      if (runtime.busy) return runtime;
      // 用上一拍的时间算「睡了多久」：页面被系统挂起时定时器不会跑，醒来后的第一拍
      // 会看到一个很大的间隔。
      const gap = runtime.lastAt > 0 ? Date.now() - runtime.lastAt : 0;
      const woke = gap > WAKE_GAP_MS && gap < 24 * 60 * 60 * 1000;
      runtime.busy = true;
      try {
        // 刚写完配置的几秒内 dsh-pet 在重启 Helper，读回来的可能是旧值；不要连续写。
        if (Date.now() - settings.lastWriteAt < 5000 && reason !== 'force') {
          runtime.note = '正在等 dsh-pet 应用配置…';
          return runtime;
        }

        const [engine, config] = await Promise.all([getEngineStatus(), getPetConfig().catch((error) => ({ __error: error }))]);
        runtime.engine = engine;
        runtime.providerReady = engine?.registered === true;
        runtime.lastAt = Date.now();

        if (config && config.__error) {
          runtime.note = '读不到 dsh-pet 配置：' + (config.__error instanceof Error ? config.__error.message : String(config.__error));
          runtime.error = runtime.note;
          return runtime;
        }
        const main = config.main;
        runtime.petConfig = config;
        runtime.managed = isBiboName(main.voiceName);
        runtime.managedVoice = runtime.managed ? String(main.voiceName).slice('bibo/'.length) : '';
        // 用户在 dsh-pet 自己的设置里把音色换成了 bibo 的另一种：以那边为准，本插件跟着改，
        // 不每 20 秒把它改回去。
        if (runtime.managed && (runtime.managedVoice === 'fish' || runtime.managedVoice === 'lumo') && runtime.managedVoice !== settings.voice) {
          saveSettings({ voice: runtime.managedVoice });
        }
        // 同理，用户在 dsh-pet 设置里改的音量也认。只在不是刚写完配置的窗口里认，
        // 避免 PUT 还没落地时读回旧值、把我们的值改回去。
        if (runtime.managed && Date.now() - settings.lastWriteAt > 15000) {
          const vol = Number(main.voiceVolume);
          if (Number.isFinite(vol) && Math.abs(vol - settings.volume) > 0.02) {
            saveSettings({ volume: Math.min(1, Math.max(0.05, vol)) });
          }
        }

        // 配置形状不认识（例如 dsh-pet 大版本换了字段名）：不猜、不写，只提示手动路径。
        const voiceFieldSeen = 'voiceName' in main || 'voiceEnabled' in main || 'voiceWhisperEnabled' in main;
        if (!voiceFieldSeen && !runtime.managed) {
          runtime.note = 'dsh-pet 的语音配置字段不认识了，未自动写入；可在 dsh-pet 设置里手动把语音选成「哔哔啵啵」';
          runtime.error = '';
          return runtime;
        }

        if (!runtime.providerReady) {
          runtime.note = '声音引擎还没接入 dsh-pet' + (engine?.reason ? '：' + engine.reason : '');
          runtime.error = '';
          return runtime;
        }

        // 睡醒且睡眠期间没有走合盖静音（例如没合盖直接系统睡眠）：主动清一次队。
        // 合盖静音已经生效时不重启，避免每次开盖都让桌宠闪一下。
        if (woke && runtime.managed && settings.enabled && !settings.userDisabled) {
          const suppressed = Number(engine?.suppressed) || 0;
          const seen = Number(settings.seenSuppressed) || 0;
          const lastSynthAt = Date.parse(engine?.lastSynthesis?.at ?? '') || 0;
          // 睡眠期间确实合成过、而且合盖静音没接住，才需要重启清队。
          // 睡了一觉但一句都没合成过时不动 Helper，避免无意义的闪一下。
          const synthDuringSleep = lastSynthAt > Date.now() - gap;
          saveSettings({ seenSuppressed: suppressed });
          if (suppressed <= seen && synthDuringSleep) {
            await flushAfterWake(main);
            return runtime;
          }
          runtime.note = suppressed > seen ? '合盖期间已静音，睡醒无需清空队列' : '睡醒检查完成：睡眠期间没有积压的语音';
          runtime.error = '';
          return runtime;
        }

        if (!settings.enabled || settings.userDisabled) {
          // 用户明确关掉：如果之前是我们接管的，就把原设置还回去，不留半个状态。
          if (runtime.managed) await restore(main);
          else runtime.note = '已停用：桌宠不会发出哔哔啵啵声';
          runtime.error = '';
          return runtime;
        }

        const wantName = 'bibo/' + settings.voice;
        const inSync =
          main.voiceName === wantName &&
          main.voiceEnabled === true &&
          main.voiceWhisperEnabled === true &&
          (!Number.isFinite(Number(main.voiceVolume)) || Math.abs(Number(main.voiceVolume) - settings.volume) < 0.02);

        if (inSync) {
          runtime.note = `已接管：${settings.voice === 'lumo' ? '路墨' : '大肥鱼'}声线`;
          runtime.error = '';
          // 升级/热重载后已经处于接管状态、但还没说过第一声：补一次（只补一次）。
          void welcome(main);
          return runtime;
        }

        if (runtime.managed) {
          // 自己接管过但音色/开关被改：以本插件设置为准，重新写回。
          await takeover(main, settings.voice, '配置有漂移，已重新接管');
          runtime.error = '';
          return runtime;
        }

        if (!voiceFlagsOn(main)) {
          // 用户原本没开语音：这是本插件要接管的主场景。
          await takeover(main, settings.voice, '首次接管');
          runtime.error = '';
          return runtime;
        }

        // 用户已经在用别的语音：尊重现状，只提示，不写。
        runtime.note = `dsh-pet 已启用其他语音${main.voiceName ? '（' + main.voiceName + '）' : ''}，未自动切换；可点「立即接管」，或在 dsh-pet 设置里选「哔哔啵啵」`;
        runtime.error = '';
        return runtime;
      } catch (error) {
        runtime.error = error instanceof Error ? error.message : String(error);
        runtime.note = '对账失败：' + runtime.error;
        log('reconcile failed', error);
        return runtime;
      } finally {
        runtime.busy = false;
        clientLog(`reconcile[${reason}] note=${runtime.note} managed=${runtime.managed} engine=${runtime.providerReady} err=${runtime.error || '-'}`);
        emit();
      }
    }

    /** 用户点了「立即接管」：即使 dsh-pet 已开着别家语音也强制切换。 */
    async function forceTakeover() {
      const config = await getPetConfig();
      const main = config.main;
      saveSettings({ enabled: true, userDisabled: false });
      await takeover(main, settings.voice, '用户手动接管');
      runtime.error = '';
      emit();
    }

    /** 用户点了「恢复原设置」。 */
    async function stopTakeover() {
      const config = await getPetConfig();
      saveSettings({ enabled: false, userDisabled: true });
      await restore(config.main);
      runtime.error = '';
      emit();
    }

    /** 改音色：已经在接管时就立刻写回 dsh-pet。 */
    async function setVoice(voice) {
      saveSettings({ voice: voice === 'lumo' ? 'lumo' : 'fish' });
      if (runtime.managed) {
        const config = await getPetConfig();
        await takeover(config.main, settings.voice, '切换声线');
      } else {
        await reconcile('force');
      }
      emit();
    }

    /** 改音量：dsh-pet 的播放音量；连续拖动时由 UI 侧防抖。 */
    async function setVolume(volume) {
      const v = Math.min(1, Math.max(0.05, Number(volume) || 0.05));
      if (Math.abs(v - settings.volume) < 0.005) return;
      saveSettings({ volume: v });
      if (runtime.managed) {
        const config = await getPetConfig();
        // 只改音量也走整包 PUT（端点不支持局部更新）。
        await putPetConfig({ ...takeoverPayload(config.main, settings.voice), voiceVolume: v });
        saveSettings({ lastWriteAt: Date.now() });
      }
      emit();
    }

    /** 试听：用宿主侧同一个合成引擎，保证听到的就是桌宠会播的。 */
    async function preview(text) {
      const payload = { text: String(text ?? '').slice(0, 220), voice: settings.voice };
      const res = await request(
        selfBase() + '/preview',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
        15000,
      );
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          if (body?.message) detail = String(body.message);
        } catch {
          /* 忽略 */
        }
        throw new Error(detail);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.volume = settings.volume;
      audio.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true });
      audio.addEventListener('error', () => URL.revokeObjectURL(url), { once: true });
      await audio.play();
    }

    /** 让桌宠真的说一句（写 dsh-pet 的 say 叶子 + 指定表面播音）：端到端验证，不是本地试听。 */
    async function tellPet(text) {
      const config = runtime.petConfig || (await getPetConfig());
      const list = Array.isArray(config?.main?.pets) ? config.main.pets : [];
      const pet = list.find((p) => p && p.display && p.display !== 'none') || list[0] || null;
      if (!pet || typeof pet.id !== 'string') throw new Error('没有可用的桌宠实例');
      if (pet.display === 'none') throw new Error('这只桌宠没有显示在任何表面');
      const surface = pet.display === 'web' ? 'web' : 'desktop';
      const res = await request(
        petBase() + '/broadcast?pet=' + encodeURIComponent(pet.id) + '&surface=' + encodeURIComponent(surface),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: String(text ?? '').slice(0, 200), speak: true, duration: 5000 }),
        },
        15000,
      );
      const body = await res.json().catch(() => null);
      if (!body || body.ok !== true) throw new Error(String(body?.message || body?.reason || 'HTTP ' + res.status));
      // 用户主动要过一声，就不再自动发欢迎语。
      saveSettings({ welcomed: true });
    }

    // ---------------------------------------------------------------- 设置页 UI
    function Section() {
      const React = require('react');
      const h = React.createElement;
      const { useCallback, useEffect, useRef, useState } = React;
      const [, force] = useState(0);
      const [busy, setBusy] = useState('');
      const [message, setMessage] = useState('');
      const [text, setText] = useState('今天吃白饭？真没饭了！');
      const [volumeShown, setVolumeShown] = useState(settings.volume);
      const volumeTimer = useRef(0);
      // 外部（设置恢复 / 别的标签页）改了音量时，滑杆跟着走。
      useEffect(() => setVolumeShown(settings.volume), [Math.round(settings.volume * 100)]);

      useEffect(() => {
        injectCss();
        const bump = () => force((n) => n + 1);
        runtime.listeners.add(bump);
        // 打开设置页时强制对账一次，别让用户盯着一个过期的状态。
        void reconcile('ui');
        return () => runtime.listeners.delete(bump);
      }, []);

      const run = useCallback(async (key, fn) => {
        setBusy(key);
        setMessage('');
        try {
          await fn();
          setMessage(key === 'preview' ? '试听完成' : key === 'tell' ? '已经让桌宠开口了' : '已保存');
        } catch (error) {
          setMessage('操作失败：' + (error instanceof Error ? error.message : String(error)));
        } finally {
          setBusy('');
        }
      }, []);

      const engineOk = runtime.providerReady;
      const managed = runtime.managed;
      const active = settings.enabled && !settings.userDisabled;
      const statusText = !runtime.lastAt
        ? '正在连接…'
        : engineOk
          ? managed
            ? `已接入 · ${runtime.managedVoice === 'lumo' ? '路墨' : '大肥鱼'}`
            : '引擎已就绪，等待接管'
          : '引擎未接入';

      return h(
        'div',
        { className: 'pbv' },
        h('h2', null, '桌宠声音'),
        h(
          'p',
          { className: 'pbv-sub' },
          '让桌宠开口就是「哔哔啵啵」。声音在本地合成，不录音、不联网；对话、自言自语和带文字的表情都会念。',
        ),
        h(
          'div',
          { className: 'pbv-card' },
          h(
            'div',
            { className: 'pbv-row pbv-row-between' },
            h(
              'div',
              { className: 'pbv-grow' },
              h('div', { className: 'pbv-title' }, '启用哔哔啵啵'),
              h('div', { className: 'pbv-hint' }, active ? '接管 dsh-pet 的语音播报，并保持设置同步。' : '已停用，桌宠保持原样。'),
            ),
            h('input', {
              type: 'checkbox',
              className: 'pbv-switch',
              checked: active,
              disabled: Boolean(busy),
              onChange: (event) => {
                const on = event.target.checked;
                if (on) {
                  saveSettings({ enabled: true, userDisabled: false });
                  void reconcile('force');
                } else {
                  void run('toggle', stopTakeover);
                }
              },
            }),
          ),
          h(
            'div',
            { className: 'pbv-status ' + (engineOk ? 'is-ok' : 'is-bad') },
            h('span', { className: 'pbv-dot' }),
            h('span', null, statusText),
            runtime.note ? h('span', { className: 'pbv-note' }, runtime.note) : null,
          ),
          runtime.error ? h('div', { className: 'pbv-error' }, runtime.error) : null,
        ),
        active
          ? h(
              'div',
              { className: 'pbv-card' },
              h('div', { className: 'pbv-title' }, '声线'),
              h(
                'div',
                { className: 'pbv-seg' },
                [
                  ['fish', '大肥鱼', '高音 · 活泼'],
                  ['lumo', '路墨', '低音 · 冷淡'],
                ].map(([id, name, tag]) =>
                  h(
                    'button',
                    {
                      key: id,
                      type: 'button',
                      className: 'pbv-seg-item' + (settings.voice === id ? ' is-on' : ''),
                      disabled: Boolean(busy),
                      onClick: () => void run('voice', () => setVoice(id)),
                    },
                    h('span', { className: 'pbv-seg-name' }, name),
                    h('span', { className: 'pbv-seg-tag' }, tag),
                  ),
                ),
              ),
              h('div', { className: 'pbv-title pbv-gap' }, '音量'),
              h('input', {
                type: 'range',
                className: 'pbv-range',
                min: 0.05,
                max: 1,
                step: 0.01,
                value: volumeShown,
                onChange: (event) => {
                  const v = Number(event.target.value);
                  setVolumeShown(v);
                  window.clearTimeout(volumeTimer.current);
                  volumeTimer.current = window.setTimeout(() => void setVolume(v), 800);
                },
              }),
              h('span', { className: 'pbv-hint' }, '实际音量'),

              h('div', { className: 'pbv-title pbv-gap' }, '试听'),
              h(
                'div',
                { className: 'pbv-row' },
                h('input', {
                  className: 'pbv-input',
                  type: 'text',
                  value: text,
                  maxLength: 220,
                  onChange: (event) => setText(event.target.value),
                  placeholder: '输入一句话',
                }),
                h(
                  'button',
                  {
                    className: 'pbv-btn',
                    type: 'button',
                    disabled: Boolean(busy) || !engineOk,
                    onClick: () => void run('preview', () => preview(text)),
                  },
                  busy === 'preview' ? '合成中…' : '本地试听',
                ),
                h(
                  'button',
                  {
                    className: 'pbv-btn',
                    type: 'button',
                    disabled: Boolean(busy) || !engineOk || !managed,
                    onClick: () => void run('tell', () => tellPet(text)),
                  },
                  busy === 'tell' ? '发送中…' : '让桌宠说',
                ),
              ),
              h(
                'div',
                { className: 'pbv-hint' },
                runtime.engine?.lastSynthesis
                  ? `上次合成：${new Date(runtime.engine.lastSynthesis.at).toLocaleTimeString()} · ${runtime.engine.lastSynthesis.chars} 字 · ${runtime.engine.lastSynthesis.voice === 'lumo' ? '路墨' : '大肥鱼'}`
                  : '还没有合成记录：触发一次碎碎念或点「让桌宠说」即可验证链路。',
              ),
              h(
                'div',
                { className: 'pbv-row pbv-actions' },
                h(
                  'button',
                  {
                    className: 'pbv-btn',
                    type: 'button',
                    disabled: Boolean(busy),
                    onClick: () => void run('force', forceTakeover),
                  },
                  '立即接管',
                ),
                h(
                  'button',
                  {
                    className: 'pbv-btn pbv-btn-ghost',
                    type: 'button',
                    disabled: Boolean(busy),
                    onClick: () => void run('restore', stopTakeover),
                  },
                  '恢复原设置',
                ),
              ),
            )
          : null,
        message ? h('div', { className: 'pbv-msg' }, message) : null,
        h(
          'p',
          { className: 'pbv-foot' },
          `v${VERSION} · 与 dsh-pet 通过公开的语音注册表 + 配置接口对接，不修改它的任何文件。`,
        ),
      );
    }

    // ---------------------------------------------------------------- 样式
    const CSS = [
      '.pbv{color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px;max-width:720px}',
      '.pbv h2{margin:0;font-size:16px;font-weight:500;line-height:24px}',
      '.pbv-sub{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:19px}',
      '.pbv-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}',
      '.pbv-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.pbv-row-between{justify-content:space-between;flex-wrap:nowrap}',
      '.pbv-grow{flex:1;min-width:0}',
      '.pbv-title{font-size:13px;font-weight:500}',
      '.pbv-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.pbv-status{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.pbv-dot{width:7px;height:7px;border-radius:50%;background:#d9534f;flex:none}',
      '.pbv-status.is-ok .pbv-dot{background:#2e9e4f}',
      '.pbv-note{color:var(--dsw-alias-label-tertiary);margin-left:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.pbv-error{font-size:12px;color:#c4322b;line-height:17px;word-break:break-word}',
      '.pbv-gap{margin-top:2px}',
      '.pbv-switch{width:34px;height:18px;accent-color:var(--dsw-alias-accent, #4d6bfe);flex:none;cursor:pointer}',
      '.pbv-seg{display:flex;gap:8px;flex-wrap:wrap}',
      '.pbv-seg-item{display:flex;flex-direction:column;align-items:flex-start;gap:2px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;border-radius:8px;padding:7px 12px;cursor:pointer;color:inherit;text-align:left}',
      '.pbv-seg-item.is-on{border-color:var(--dsw-alias-accent, #4d6bfe);background:color-mix(in srgb, var(--dsw-alias-accent, #4d6bfe) 10%, transparent)}',
      '.pbv-seg-name{font-size:13px}',
      '.pbv-seg-tag{font-size:11.5px;color:var(--dsw-alias-label-tertiary)}',
      '.pbv-range{width:100%;accent-color:var(--dsw-alias-accent, #4d6bfe)}',
      '.pbv-input{flex:1;min-width:180px;background:transparent;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:13px;height:30px;padding:0 9px;outline:none}',
      '.pbv-btn{height:30px;padding:0 12px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-l2, rgba(127,127,127,.08));color:var(--dsw-alias-label-primary);font-size:13px;cursor:pointer}',
      '.pbv-btn:disabled{opacity:.5;cursor:default}',
      '.pbv-btn-ghost{background:transparent}',
      '.pbv-actions{margin-top:2px}',
      '.pbv-msg{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.pbv-foot{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:17px}',
    ];
    let cssInjected = false;
    function injectCss() {
      if (cssInjected || typeof document === 'undefined') return;
      cssInjected = true;
      const el = document.createElement('style');
      el.id = 'dsh-pet-bibo-voice/css';
      el.textContent = CSS.join('\n');
      document.head.appendChild(el);
    }

    // ---------------------------------------------------------------- 对外调试面
    function exposeDebug() {
      try {
        window.__DSH_PET_BIBO__ = {
          version: VERSION,
          get status() {
            return {
              ...runtime,
              settings: { ...settings, snapshot: settings.snapshot ? { ...settings.snapshot } : null },
              petBase: petBase(),
              selfBase: selfBase(),
            };
          },
          reconcile: (reason) => reconcile(reason || 'debug'),
          takeover: forceTakeover,
          restore: stopTakeover,
          setVoice,
          setVolume,
          preview,
          tellPet,
          getConfig: getPetConfig,
        };
      } catch {
        /* window 被冻结也无所谓 */
      }
    }

    // ---------------------------------------------------------------- 生命周期
    const timers = [];
    let started = false;

    function start(ctx) {
      if (started) return;
      started = true;
      exposeDebug();

      // 第一次对账给 dsh-pet 一点时间：页面刚加载时它的 /config 与宿主服务都可能还没就绪。
      timers.push(window.setTimeout(() => void reconcile('boot-1'), 1800));
      timers.push(window.setTimeout(() => void reconcile('boot-2'), 6000));
      timers.push(window.setTimeout(() => void reconcile('boot-3'), 15000));
      const interval = window.setInterval(() => void reconcile('health'), RECONCILE_MS);
      timers.push(interval);

      // 回到前台时补一次：后台标签页里的定时器会被浏览器节流。
      const onVisible = () => {
        if (document.visibilityState === 'visible') void reconcile('visible');
      };
      document.addEventListener('visibilitychange', onVisible);
      timers.push(() => document.removeEventListener('visibilitychange', onVisible));

      log('client ready', VERSION, petBase());
      clientLog(`client boot v${VERSION} base=${mountPrefix()} engine=${runtime.providerReady}`);
    }

    function stop() {
      for (const timer of timers.splice(0)) {
        try {
          if (typeof timer === 'function') timer();
          else window.clearTimeout(timer);
        } catch {
          /* 清理失败不影响卸载 */
        }
      }
      started = false;
    }

    // ---------------------------------------------------------------- 插件入口
    const inject = ['slots'];

    function apply(ctx) {
      injectCss();
      // 设置页：标题与顺序跟随 DSH 设置导航；没有 slots 时只降级为后台接管。
      try {
        ctx.effect(
          () => {
            const off = ctx.slots.inject(
              'settings.section',
              () => ctx.slots.register({ name: 'settings.section', id: NS, order: 8, label: () => '桌宠声音' }, Section),
              'dsh-pet-bibo-voice: settings section',
            );
            clientLog('settings section registered');
            return off;
          },
          'dsh-pet-bibo-voice: settings section',
        );
      } catch (error) {
        log('settings section unavailable', error);
        clientLog('settings section failed: ' + (error instanceof Error ? error.message : String(error)));
      }
      start(ctx);
      ctx.effect(() => () => stop(), 'dsh-pet-bibo-voice: controller');
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.Section = Section;
    return module.exports;
  },
});
