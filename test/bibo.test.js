/**
 * 合成引擎的回归测试：
 *   1. 与原仓库 bibibobo 的 synth() 逐位对拍（默认参数），确保「一个字的音高/口型」没有跑偏；
 *   2. WAV 容器格式正确；
 *   3. 清理器只留下能念的内容；
 *   4. 空文本必须抛错（宿主会把它归成失败，不写缓存）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { synth, toWav, toSpeakable, synthesize, VOICES as BIBO_VOICES } from '../lib/bibo.js';
import { synth as referenceSynth } from './reference-bibibobo.js';

const TEXTS = ['今天吃白饭？', '真没饭了！', '才不是大肥鱼……', '哦鲸鲸，我不更新你们用什么', '好的。'];
const VOICE_IDS = ['fish', 'lumo'];

test('与原仓库 synth() 逐位一致（默认参数）', () => {
  for (const voice of VOICE_IDS) {
    for (const text of TEXTS) {
      const ours = synth(text, { voice });
      const ref = referenceSynth(text, { voice });
      assert.equal(ours.length, ref.length, `${voice}/${text} 采样长度`);
      for (let i = 0; i < ref.length; i++) {
        assert.equal(ours[i], ref[i], `${voice}/${text} 第 ${i} 个采样`);
      }
    }
  }
});

test('同一个字永远是同一声（确定性）', () => {
  const a = toWav(synth('吃饭饭', { voice: 'fish' }));
  const b = toWav(synth('吃饭饭', { voice: 'fish' }));
  assert.deepEqual(a, b);
});

test('WAV 头与长度正确', () => {
  const samples = synth('今天吃白饭？');
  const wav = toWav(samples);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const ascii = (offset, length) => String.fromCharCode(...wav.slice(offset, offset + length));
  assert.equal(ascii(0, 4), 'RIFF');
  assert.equal(ascii(8, 4), 'WAVE');
  assert.equal(ascii(12, 4), 'fmt ');
  assert.equal(ascii(36, 4), 'data');
  assert.equal(view.getUint16(20, true), 1, 'PCM');
  assert.equal(view.getUint16(22, true), 1, '单声道');
  assert.equal(view.getUint32(24, true), 44100);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), samples.length * 2);
  assert.equal(wav.length, 44 + samples.length * 2);
  assert.equal(view.getUint32(4, true), wav.length - 8);
});

test('采样有声音且不削顶', () => {
  const samples = synth('今天吃白饭？真没饭了！');
  let peak = 0;
  for (const value of samples) {
    assert.ok(Number.isFinite(value));
    assert.ok(value >= -1 && value <= 1);
    peak = Math.max(peak, Math.abs(value));
  }
  assert.ok(peak > 0.05, `峰值太低：${peak}`);
});

function activeDuration(samples, sampleRate = 44100) {
  let last = -1;
  for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]) > 1e-4) last = i;
  return last / sampleRate;
}

test('问号与感叹号都会让尾音更长', () => {
  const ask = activeDuration(synth('没饭了？'));
  const plain = activeDuration(synth('没饭了'));
  const shout = activeDuration(synth('没饭了！'));
  assert.ok(ask > plain + 0.02, `问句尾音应当更长：${ask} vs ${plain}`);
  assert.ok(shout > plain + 0.02, `感叹句尾音应当更长：${shout} vs ${plain}`);
});

test('清理器去掉 Markdown / 链接 / 表情，只留能念的内容', () => {
  assert.equal(toSpeakable('`code` 和 **粗体**'), '和 粗体');
  assert.equal(toSpeakable('看这个 https://example.com/x 好玩'), '看这个 好玩');
  assert.equal(toSpeakable('翻肚皮 🐳 吐泡泡'), '翻肚皮 吐泡泡');
  assert.equal(toSpeakable('![图](a.png) 真的'), '真的');
  assert.equal(toSpeakable('   '), '');
  assert.equal(toSpeakable('<b>哦鲸鲸</b>'), '哦鲸鲸');
});

test('空内容合成必须抛错', () => {
  assert.throws(() => synthesize('```\ncode\n```'), /没有可念的内容/);
  assert.throws(() => synthesize(''), /没有可念的内容/);
});

test('synthesize() 一站式返回可播 WAV', () => {
  const { wav, samples, text, sampleRate } = synthesize('**真没饭了！**', { voice: 'lumo' });
  assert.equal(text, '真没饭了！');
  assert.equal(sampleRate, 44100);
  assert.equal(wav.length, 44 + samples.length * 2);
  assert.ok(BIBO_VOICES.lumo);
});
