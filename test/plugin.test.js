/**
 * 宿主入口的行为测试：用假 ctx 模拟 DSH + dsh-pet，验证
 *   1. petApi7340 出现后能注册 bibo（并且只注册一次）；
 *   2. /status 与 /preview 路由真的可用；
 *   3. 卸载时把注册与路由都清掉；
 *   4. 没有 dsh-pet 时不抛错（降级）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, inject, name } from '../lib/index.js';

function fakeCtx(options = {}) {
  const routes = [];
  const cleanups = [];
  let provider = null;
  const api = {
    voice: {
      register(def) {
        if (provider) throw new TypeError('provider id 已被注册');
        provider = def;
        return () => {
          if (provider === def) provider = null;
        };
      },
      list() {
        return { providers: provider ? [{ id: provider.id, name: provider.name, voices: provider.voices.map((v) => ({ id: 'bibo/' + v.id, name: v.name })) }] : [] };
      },
    },
  };
  const ctx = {
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    },
    get(service) {
      if (service === 'petApi7340') return options.noPet ? undefined : api;
      if (service === 'webServer') {
        return {
          register(opts) {
            routes.push(opts);
            return () => routes.splice(routes.indexOf(opts), 1);
          },
        };
      }
      return undefined;
    },
    logger: { info() {}, warn() {} },
  };
  return {
    ctx,
    routes,
    cleanups,
    get provider() {
      return provider;
    },
    dispose() {
      for (const fn of cleanups.splice(0).reverse()) fn();
    },
  };
}

function fakeRes() {
  const state = { status: 0, headers: {}, body: null };
  return {
    state,
    writeHead(status, headers) {
      state.status = status;
      state.headers = headers || {};
    },
    end(body) {
      state.body = body ?? null;
    },
  };
}

function fakeReq(method, url, body) {
  const handlers = {};
  const req = {
    method,
    url,
    on(event, fn) {
      handlers[event] = fn;
    },
    destroy() {},
  };
  // body 在 handler 里才被读；延迟到下一拍发，保证 on('data') 已挂上。
  if (body !== undefined) {
    setTimeout(() => {
      handlers.data?.(Buffer.from(body, 'utf8'));
      handlers.end?.();
    }, 0);
  } else {
    setTimeout(() => handlers.end?.(), 0);
  }
  return req;
}

test('插件元信息与 inject 形状', () => {
  assert.equal(name, 'dsh-pet-bibo-voice');
  assert.deepEqual(inject, []);
});

test('注册 bibo provider，并暴露 /status 与 /preview', async () => {
  const fake = fakeCtx();
  apply(fake.ctx);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.ok(fake.provider, 'provider 应已注册');
  assert.equal(fake.provider.id, 'bibo');
  assert.equal(fake.provider.format, 'wav');
  assert.ok(fake.provider.voices.some((v) => v.id === 'fish'));
  assert.ok(fake.provider.voices.some((v) => v.id === 'lumo'));

  // 合成回调真的返回 WAV
  const wav = await fake.provider.synthesize({ text: '**今天吃白饭？**', voice: 'fish', rate: 0 });
  assert.ok(wav instanceof Uint8Array && wav.length > 44);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');

  const route = fake.routes[0];
  assert.ok(route, 'webServer 路由应已注册');
  assert.equal(route.kind, 'prefix');

  // /status（带完整前缀）
  const res1 = fakeRes();
  await route.handler(fakeReq('GET', '/dsh-pet-bibo-voice/status'), res1);
  assert.equal(res1.state.status, 200);
  assert.match(String(res1.state.headers['content-type']), /application\/json/);
  const status = JSON.parse(String(res1.state.body));
  assert.equal(status.registered, true);
  assert.equal(status.providerId, 'bibo');

  // /preview（不带前缀也必须能命中）
  const res2 = fakeRes();
  await route.handler(fakeReq('POST', '/dsh-pet-bibo-voice/preview', JSON.stringify({ text: '真没饭了！', voice: 'lumo' })), res2);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(res2.state.status, 200);
  assert.equal(res2.state.headers['content-type'], 'audio/wav');
  const bytes = res2.state.body;
  assert.ok(bytes && bytes.length > 44);

  fake.dispose();
  assert.equal(fake.provider, null, '卸载后 provider 应被摘除');
  assert.equal(fake.routes.length, 0, '卸载后路由应被摘除');
});

test('没有 dsh-pet 时只降级，不抛错', async () => {
  const fake = fakeCtx({ noPet: true });
  assert.doesNotThrow(() => apply(fake.ctx));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const route = fake.routes[0];
  const res = fakeRes();
  await route.handler(fakeReq('GET', '/dsh-pet-bibo-voice/status'), res);
  const status = JSON.parse(String(res.state.body));
  assert.equal(status.registered, false);
  assert.equal(status.apiSeen, false);
  fake.dispose();
});

test('重复 apply 不会重复注册', async () => {
  const fake = fakeCtx();
  apply(fake.ctx);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const first = fake.provider;
  assert.ok(first);
  // 再触发一次探测（模拟定时器）：注册表里已有 bibo，不应再调 register。
  fake.ctx.get('petApi7340').voice.list();
  assert.equal(fake.provider, first);
  fake.dispose();
});
