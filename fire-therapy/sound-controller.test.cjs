const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

async function verify(useWebAudio) {
  let audio, gain, nextFrame = null, now = 0;
  let resumeCount = 0, rejectPlay = false;
  const events = {};
  class Audio {
    constructor() { audio = this; this.volume = 0; this.paused = true; }
    setAttribute() {}
    addEventListener(name, callback) { events[name] = callback; }
    load() {}
    async play() {
      if (rejectPlay) throw new Error('playback denied');
      this.paused = false;
    }
    pause() { this.paused = true; }
  }
  class AudioContext {
    constructor() { this.state = 'suspended'; this.destination = {}; }
    createMediaElementSource() { return { connect() {} }; }
    createGain() { gain = { gain: { value: 0 }, connect() {} }; return gain; }
    async resume() { this.state = 'running'; resumeCount++; }
  }
  const context = {
    window: useWebAudio ? { AudioContext } : {}, Audio, Math,
    requestAnimationFrame: (callback) => { nextFrame = callback; return 1; },
    cancelAnimationFrame: () => { nextFrame = null; }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'sound-controller.js'), 'utf8'), context);
  const controller = context.window.createSoundController();
  const output = () => useWebAudio ? gain?.gain.value || 0 : audio.volume;
  const advance = (frames = 600) => {
    for (let i = 0; i < frames && nextFrame; i++) {
      now += 1000 / 60;
      const callback = nextFrame;
      nextFrame = null;
      callback(now);
    }
    return output();
  };
  const measure = (energy) => { controller.setFireState(energy); return advance(); };
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.00001, `${actual} ~= ${expected}`);
  assert.equal(audio.paused, true, 'no autoplay');
  await controller.setVolume(100);
  if (useWebAudio) assert.equal(resumeCount, 1, 'context resumes after user volume change');
  const calm = measure(0.78), warm = measure(1), deep = measure(1.18);
  assert.ok(calm < warm && warm < deep, 'each flame stage increases sound');
  const touch = measure(1.18 + 0.34);
  const wind = measure(1.18 + 1.18 * 0.55);
  assert.ok(touch > deep && wind > deep, 'touch and fanning increase sound');
  const maximum = measure(1.18 * 1.6);
  close(maximum, 1);
  assert.ok(measure(1.18 * 0.35) < deep, 'timer fade reduces sound');
  await controller.setVolume(50);
  close(measure(1.18 * 1.6), 0.5);
  await controller.setVolume(1000);
  assert.equal(controller.getVolume(), 100, 'volume upper bound');
  close(measure(100), 1);
  assert.equal(await controller.setVolume(NaN), false);
  const before = output();
  controller.setFireState(0.78);
  advance(1);
  assert.ok(output() < before && output() > calm, 'volume fades instead of jumping');
  await controller.setVolume(0);
  assert.equal(output(), 0, 'zero mutes immediately');
  assert.equal(audio.paused, true);
  controller.setFireState(100);
  advance();
  assert.equal(output(), 0, 'large flame cannot unmute sound');
  await controller.setVolume(25);
  close(measure(1.18 * 1.6), 0.25);
  rejectPlay = true;
  assert.equal(await controller.setVolume(80), false);
  assert.equal(output(), 0, 'playback failure mutes');
  assert.equal(controller.getVolume(), 0);
  events.error();
  assert.equal(controller.isAvailable(), false);
  assert.equal(await controller.setVolume(50), false);
  console.log(`${useWebAudio ? 'Web Audio' : 'media fallback'}: stages ${[calm, warm, deep].map(v => Math.round(v * 100)).join(' / ')}, touch, fanning, fade, 0–100 limits and failures passed`);
}

(async () => { await verify(true); await verify(false); })()
  .catch((error) => { console.error(error); process.exitCode = 1; });
