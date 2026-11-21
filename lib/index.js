/**
 * 宿主半侧：把「哔哔啵啵」注册成 dsh-pet 的第三方语音实现。
 *
 * 为什么走注册表而不是改 dsh-pet 的代码：
 *   dsh-pet 在 `ctx.provide('petApi7340', { voice: { register, list } })` 里公开了第三方语音槽
 *   （源码注释：「第三方注册自己的合成实现，非空时合成走它」）。这条服务是宠物插件
 *   对外的稳定契约，注册进去之后，桌宠在网页、桌面 Helper、独立模式里都会照常走它自己的
 *   播放链路——我们不需要知道气泡、动画、状态轮询长什么样，也不会被这些内部实现的变化带着一起碎。
 *
 * 更新不失效的四道保险：
 *   1. 只依赖 petApi7340 / voice.register / voices 三个公开形状，不 import dsh-pet 任何模块；
 *   2. 服务可能晚于本插件就绪，也可能随 dsh-pet 热重载换掉 → 定时探测，发现注册表里没有
 *      bibo 就重新注册（disposer 先清旧的那条）；
 *   3. 注册失败只降级、不抛错：其余插件与桌宠照常跑，设置页会显示「未接入」；
 *   4. 自己的 HTTP 路由只做状态与试听，不碰 dsh-pet 的状态存储。
 *
 * @module dsh-pet-bibo-voice
 */

import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { synthesize, toSpeakable, toWav, VOICE_LIST, VOICES } from './bibo.js';

export const name = 'dsh-pet-bibo-voice';
/** 不声明任何 DSH 服务依赖：dsh-pet 缺失也要能加载，只是没有声音。 */
export const inject = [];

const VERSION = '0.1.1';
const PROVIDER_ID = 'bibo';
const PROVIDER_NAME = '哔哔啵啵';
const ROUTE_PATH = '/dsh-pet-bibo-voice';
const ROUTE_SEGMENT = '/dsh-pet-bibo-voice';
const LOG_LIMIT = 256 * 1024;
const execFileAsync = promisify(execFile);

/**
 * 合盖休眠保护：合盖后 macOS 会把播放中的音频挂起，醒来时可能把睡觉期间攒下的
 * 好几条一起放出来。这里在合成入口判断「盖子是不是合着」，合着就返回一小段静音——
 * 桌宠的播放链路照常走，但不会在睡眠期间攒出可听的音频。
 *
 * 只在 macOS 生效；读不到状态一律按「开着」处理，不误伤正常说话。
 */
async function isLidClosed() {
  if (process.platform !== 'darwin') return false;
  try {
    const { stdout } = await execFileAsync('/usr/sbin/ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '4'], {
      encoding: 'utf8',
      timeout: 1200,
    });
    return /"AppleClamshellState"\s*=\s*Yes/.test(stdout);
  } catch {
    return false;
  }
}

/** 外接显示器缓存：合盖但接着外接屏时人是醒着的，不该静音。 */
let externalDisplayCache = { at: 0, value: false };
async function hasExternalDisplay() {
  if (process.platform !== 'darwin') return false;
  if (Date.now() - externalDisplayCache.at < 60000) return externalDisplayCache.value;
  let value = false;
  try {
    const { stdout } = await execFileAsync('/usr/sbin/system_profiler', ['SPDisplaysDataType'], {
      encoding: 'utf8',
      timeout: 2500,
    });
    const count = (stdout.match(/^\s+Resolution:/gm) ?? []).length;
    const builtIn = /Built-In|Color LCD/i.test(stdout);
    value = count > 1 || (count === 1 && !builtIn);
  } catch {
    /* 读不到就按没有外接屏处理（宁可少响，也不在合盖时堆积） */
  }
  externalDisplayCache = { at: Date.now(), value };
  return value;
}

/** 现在该不该把声音换成静音（合盖睡眠且没有外接屏）。 */
export async function shouldSilenceForSleep() {
  if (process.env.DSH_PET_BIBO_FORCE_SLEEP === '1') return true;
  if (!(await isLidClosed())) return false;
  return !(await hasExternalDisplay());
}

/** 一小段静音 WAV：0.05 秒，合盖期间用它占住播放链路。 */
export function sleepSilenceWav() {
  return toWav(new Float32Array(2205), 44100);
}
const PROBE_MS = 2500;
const PROBE_SLOW_MS = 15000;

/** 进程内状态：只给 /status 与日志用，不落盘。 */
/** 探测 dsh-pet 的版本用于排障；读不到就留空（例如更新后改了 exports，不影响发声）。 */
function detectPetVersion() {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req('dsh-pet/package.json');
    return typeof pkg?.version === 'string' ? pkg.version : '';
  } catch {
    return '';
  }
}

const status = {
  version: VERSION,
  dshPetVersion: detectPetVersion(),
  providerId: PROVIDER_ID,
  registered: false,
  apiSeen: false,
  reason: '尚未探测到 dsh-pet',
  since: null,
  lastAttemptAt: null,
  attempts: 0,
};

/**
 * 读一个 DSH 服务，缺了也不抛。
 *
 * dsh-pet 源码里记过：DSH 的 ctx 是严格 getter，读没写进 inject 的服务会抛异常；
 * 所以必须走 `ctx.get(name, false)`，读不到就当没有。
 */
function readService(ctx, serviceName) {
  try {
    if (typeof ctx?.get === 'function') return ctx.get(serviceName, false);
  } catch {
    /* 严格 getter：没注册就是没有 */
  }
  try {
    return ctx?.[serviceName];
  } catch {
    return undefined;
  }
}

/** 统一日志出口：ctx.logger 可能不存在（桌面版没有控制台），同时留一份自己的文件方便排障。 */
function makeLogger(ctx) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const dir = join(home, 'dsh-pet-bibo-voice');
  const file = join(dir, 'log.txt');
  return (level, message) => {
    const line = `${new Date().toISOString()} [${level}] ${message}\n`;
    try {
      mkdirSync(dir, { recursive: true });
      try {
        if (statSync(file).size > LOG_LIMIT) writeFileSync(file, '', 'utf8');
      } catch {
        /* 文件还不存在 */
      }
      appendFileSync(file, line, 'utf8');
    } catch {
      /* 写日志失败不能影响主流程 */
    }
    try {
      const fn = ctx?.logger?.[level];
      if (typeof fn === 'function') fn.call(ctx.logger, `[dsh-pet-bibo-voice] ${message}`);
    } catch {
      /* ctx.logger 形状不对就只留文件 */
    }
  };
}

/** 构造注册给 dsh-pet 的 provider；每次注册都新建一个，避免上一份 registry 的引用被复用。 */
function makeProvider(log) {
  return {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    voices: VOICE_LIST.map((v) => ({ ...v })),
    format: 'wav',
    timeoutMs: 8000,
    async synthesize(input) {
      const voice = typeof input?.voice === 'string' && Object.hasOwn(VOICES, input.voice) ? input.voice : 'fish';
      // 合盖睡眠时不合成可听内容：否则睡觉期间每句都会在系统音频队列里排着，
      // 开盖后一起放出来。静音 WAV 仍满足 dsh-pet「非空字节」的要求。
      if (await shouldSilenceForSleep()) {
        status.suppressed = (status.suppressed ?? 0) + 1;
        status.lastSuppressedAt = new Date().toISOString();
        log?.('info', '合盖休眠中，这句返回静音');
        return sleepSilenceWav();
      }
      const rate = Number(input?.rate);
      const { wav, text } = synthesize(input?.text, { voice, rate: Number.isFinite(rate) ? rate : 0 });
      status.lastSynthesis = { at: new Date().toISOString(), chars: text.length, bytes: wav.length, voice };
      log?.('info', `合成完成 voice=${voice} chars=${text.length} bytes=${wav.length}`);
      return wav;
    },
  };
}

/** 从 dsh-pet 的注册表里看看 bibo 在不在。 */
function catalogHas(listResult) {
  try {
    const providers = listResult?.providers;
    if (!Array.isArray(providers)) return undefined;
    return providers.some((p) => p && p.id === PROVIDER_ID);
  } catch {
    return undefined;
  }
}

/**
 * 探测并注册。反复调用是安全的：注册表里已经有 bibo 就什么都不做。
 *
 * @param ctx - 宿主上下文。
 * @param log - 日志函数。
 * @param state - 本次插件实例的注册状态（disposer / 上次 service 引用）。
 * @returns {boolean} 当前是否已注册。
 */
function ensureRegistered(ctx, log, state) {
  const api = readService(ctx, 'petApi7340');
  status.apiSeen = Boolean(api);
  status.attempts += 1;
  status.lastAttemptAt = new Date().toISOString();

  if (!api || typeof api !== 'object') {
    status.registered = false;
    status.reason = '还没探测到 dsh-pet（确认 dsh-pet 已启用）';
    return false;
  }
  const voice = api.voice;
  if (!voice || typeof voice.register !== 'function') {
    status.registered = false;
    status.reason = 'dsh-pet 的版本没有提供 petApi7340.voice.register';
    return false;
  }

  let listed;
  try {
    listed = typeof voice.list === 'function' ? voice.list() : undefined;
  } catch {
    listed = undefined;
  }
  const has = catalogHas(listed);

  if (has === true) {
    // 注册表里已经有（可能来自上一次 apply / 热重载后的另一实例）：不再重复注册。
    if (state.api !== api) {
      state.api = api;
      state.owns = false;
    }
    status.registered = true;
    status.reason = '';
    return true;
  }

  // list 不可用且同一个 service 上已经成功注册过：不重复打注册表（重复会抛「id 已被注册」）。
  if (has === undefined && state.api === api && status.registered) return true;

  // 旧注册先摘掉：dsh-pet 热重载后旧 disposer 可能已经指向一个被丢弃的 registry，
  // 但清一下没有副作用；新 registry 里没东西可删。
  try {
    state.dispose?.();
  } catch {
    /* 旧注册表不在就不在 */
  }
  state.dispose = null;
  state.owns = false;

  try {
    const provider = makeProvider(log);
    const dispose = voice.register(provider);
    state.dispose = typeof dispose === 'function' ? dispose : null;
    state.api = api;
    state.owns = true;
    status.registered = true;
    status.reason = '';
    status.since = new Date().toISOString();
    log('info', `已注册语音实现 ${PROVIDER_ID}（${VOICE_LIST.map((v) => v.id).join(' / ')}），dsh-pet 可直接选用`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 并发/重复探测撞上「已被注册」不算失败：说明注册表里已经有 bibo 了。
    if (message.includes('已被注册') || message.includes('already')) {
      state.api = api;
      status.registered = true;
      status.reason = '';
      return true;
    }
    status.registered = false;
    status.reason = `注册失败：${message}`;
    log('warn', `注册语音实现失败：${message}`);
    return false;
  }
}

/** 读取请求体；超过上限直接断开，避免大 payload 把宿主内存吃满。 */
function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, body) {
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-store',
  });
  res.end(data);
}

/** 自己的 HTTP 路由：只给设置页看状态、听试听，不代理 dsh-pet 的任何东西。 */
function makeRouteHandler(ctx, log) {
  return async (req, res) => {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      return sendJson(res, 400, { ok: false, reason: 'bad-request' });
    }
    // webServer 可能把挂载前缀已经剥掉，也可能原样传进来：两种都认。
    const sub = (url.pathname.startsWith(ROUTE_SEGMENT) ? url.pathname.slice(ROUTE_SEGMENT.length) : url.pathname).replace(/^\/+/, '');

    if (sub === 'status' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, ...status, voices: VOICE_LIST });
    }

    if (sub === 'ping' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, version: VERSION });
    }

    // 浏览器半侧留一行诊断：页面有没有加载到插件、对账结论是什么。只写文件，不落任何用户数据。
    if (sub === 'client-log' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req, 32 * 1024);
      } catch {
        return sendJson(res, 400, { ok: false, reason: 'bad-request' });
      }
      const message = String(body?.message ?? '').replace(/[\r\n]+/g, ' ').slice(0, 600);
      if (message) log('client', message);
      return sendJson(res, 200, { ok: true });
    }

    if (sub === 'preview' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return sendJson(res, message === 'payload too large' ? 413 : 400, { ok: false, reason: 'bad-request', message });
      }
      const text = toSpeakable(body?.text ?? '今天吃白饭？真没饭了！', 220);
      if (!text) return sendJson(res, 400, { ok: false, reason: 'empty-text', message: '没有可念的内容' });
      try {
        const voiceId = typeof body?.voice === 'string' && Object.hasOwn(VOICES, body.voice) ? body.voice : 'fish';
        const { wav, text: spoken } = synthesize(text, { voice: voiceId });
        res.writeHead(200, {
          'content-type': 'audio/wav',
          'content-length': wav.length,
          'cache-control': 'no-store',
          'x-bibo-text': encodeURIComponent(spoken),
        });
        res.end(Buffer.from(wav));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log('warn', `试听合成失败：${message}`);
        return sendJson(res, 500, { ok: false, reason: 'generate-error', message });
      }
      return undefined;
    }

    return sendJson(res, 404, { ok: false, reason: 'not-found' });
  };
}

/**
 * 插件入口。
 *
 * @param ctx - DSH 宿主上下文。
 */
export function apply(ctx) {
  const log = makeLogger(ctx);
  const state = { api: null, dispose: null, owns: false, timer: null, timerMs: PROBE_MS, probeCount: 0 };
  let disposed = false;

  const probe = () => {
    if (disposed) return;
    try {
      ensureRegistered(ctx, log, state);
    } catch (error) {
      status.registered = false;
      status.reason = error instanceof Error ? error.message : String(error);
      log('warn', `探测 dsh-pet 语音注册表时出错：${status.reason}`);
    }
    state.probeCount += 1;
    // 前 12 次（约 30 秒）密集探测：插件启动顺序不保证，dsh-pet 可能稍后才 provide；
    // 之后放缓到 15 秒一次，兼顾热重载与开销。
    const next = state.probeCount < 12 ? PROBE_MS : PROBE_SLOW_MS;
    if (next !== state.timerMs) {
      state.timerMs = next;
      clearInterval(state.timer);
      state.timer = setInterval(probe, next);
      state.timer.unref?.();
    }
  };

  ctx.effect(
    () => {
      log('info', `启动 v${VERSION}，等待 dsh-pet${status.dshPetVersion ? ' v' + status.dshPetVersion : ''} 的 petApi7340 服务`);
      // 先立刻探测一次，再起循环。
      probe();
      state.timer = setInterval(probe, state.timerMs);
      state.timer.unref?.();

      // 自己的路由：注册在 DSH webServer 上。拿不到 webServer 只影响设置页状态，不影响发声。
      let offRoute;
      try {
        const webServer = readService(ctx, 'webServer');
        if (webServer && typeof webServer.register === 'function') {
          offRoute = webServer.register({
            kind: 'prefix',
            path: ROUTE_SEGMENT,
            handler: makeRouteHandler(ctx, log),
          });
        } else {
          log('warn', '没有 webServer 服务，设置页将读不到本插件的状态与试听（发声不受影响）');
        }
      } catch (error) {
        log('warn', `注册 HTTP 路由失败：${error instanceof Error ? error.message : String(error)}`);
      }

      return () => {
        disposed = true;
        clearInterval(state.timer);
        try {
          state.dispose?.();
        } catch {
          /* 插件卸载时 dsh-pet 可能已经不在了 */
        }
        try {
          offRoute?.();
        } catch {
          /* 同上 */
        }
        log('info', '已卸载：语音实现已从 dsh-pet 注册表摘除');
      };
    },
    'dsh-pet-bibo-voice: provider + routes',
  );
}
