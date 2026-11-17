const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

let now = 0;
let nextFrame = null;
let sample = null;
let stopped = 0;
let cameraRequests = 0;
const states = [];
const documentListeners = {};
const video = {
  muted: false,
  playsInline: false,
  readyState: 2,
  currentTime: 0,
  setAttribute() {},
  play: async () => {},
  pause() {},
  srcObject: null
};
const track = { stop: () => { stopped++; }, addEventListener() {} };
const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
const context = {
  window: {},
  navigator: { mediaDevices: { getUserMedia: async (constraints) => {
    assert.equal(constraints.audio, false);
    cameraRequests++;
    return stream;
  } } },
  document: { hidden: false, createElement: () => video, addEventListener: (name, callback) => { documentListeners[name] = callback; } },
  requestAnimationFrame: (callback) => { nextFrame = callback; return 1; },
  cancelAnimationFrame: () => { nextFrame = null; },
  Math,
  console
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'hand-controller.js'), 'utf8'), context);

function landmarks(y, x = 0.5) {
  if (y === null) return undefined;
  const points = Array.from({ length: 21 }, () => ({ x, y }));
  points[0] = { x, y: y + 0.06 };
  points[9] = { x, y: y - 0.06 };
  return points;
}

function step(y, x = 0.5, elapsed = 80) {
  feed(landmarks(y, x), elapsed);
}

function feed(points, elapsed = 80) {
  now += elapsed;
  video.currentTime += elapsed / 1000;
  sample = points;
  assert.ok(nextFrame, 'tracking loop should be active');
  const callback = nextFrame;
  nextFrame = null;
  callback(now);
}

function stroke(from, to, steps) {
  for (let i = 1; i <= steps; i++) step(from + (to - from) * i / steps);
}

(async () => {
  const controller = context.window.createHandController({
    onStateChange: ({ state }) => states.push(state),
    loadLandmarker: async () => ({ detectForVideo: () => ({ landmarks: sample ? [sample] : [] }) })
  });
  assert.equal(cameraRequests, 0, 'camera stays off by default');
  await controller.start();
  assert.equal(cameraRequests, 1);
  for (let i = 0; i < 8; i++) step(null);
  assert.equal(controller.getStrength(), 0, 'no hand');
  for (let i = 0; i < 12; i++) step(0.5);
  assert.equal(controller.getStrength(), 0, 'still hand');
  stroke(0.5, 0.25, 8);
  assert.equal(controller.getStrength(), 0, 'one-direction movement');
  stroke(0.25, 0.75, 8);
  stroke(0.75, 0.25, 8);
  stroke(0.25, 0.75, 8);
  assert.ok(controller.getStrength() > 0.2, 'repeated vertical fanning');
  const slowStrength = controller.getStrength();
  assert.ok(states.includes('slow') || states.includes('fast'));
  for (let i = 0; i < 24; i++) step(0.75);
  assert.ok(controller.getStrength() < 0.2, 'strength decays after stopping');
  controller.stop();
  assert.equal(stopped, 1, 'camera track stops');
  assert.equal(controller.getStrength(), 0);
  await controller.start();
  assert.equal(cameraRequests, 2, 'camera can be re-enabled');
  for (let i = 0; i < 16; i++) step(0.5, 0.2 + i * 0.035);
  assert.equal(controller.getStrength(), 0, 'sideways movement is ignored');
  stroke(0.5, 0.25, 4);
  stroke(0.25, 0.75, 4);
  stroke(0.75, 0.25, 4);
  stroke(0.25, 0.75, 4);
  stroke(0.75, 0.25, 4);
  stroke(0.25, 0.75, 4);
  assert.ok(controller.getStrength() > slowStrength, `faster reversals produce stronger response (${controller.getStrength()} > ${slowStrength})`);
  context.document.hidden = true;
  documentListeners.visibilitychange();
  assert.equal(stopped, 2, 'backgrounding stops the camera track');
  assert.equal(states.at(-1), 'off');
  context.document.hidden = false;
  await controller.start();
  assert.equal(cameraRequests, 3, 'camera restarts only after an explicit ON');
  controller.stop();

  let resolvePermission;
  context.navigator.mediaDevices.getUserMedia = () => new Promise((resolve) => { resolvePermission = resolve; });
  const pendingController = context.window.createHandController({ loadLandmarker: async () => ({}) });
  const pendingStart = pendingController.start();
  pendingController.stop();
  resolvePermission(stream);
  await pendingStart;
  assert.equal(stopped, 4, 'a late permission result is released after OFF');
  assert.equal(pendingController.getStrength(), 0);

  context.navigator.mediaDevices.getUserMedia = async () => stream;
  const failureStates = [];
  const failedModel = context.window.createHandController({
    onStateChange: ({ state }) => failureStates.push(state),
    loadLandmarker: async () => { throw new Error('model unavailable'); }
  });
  await failedModel.start();
  assert.equal(failureStates.at(-1), 'error', 'model failure is reported');
  assert.equal(stopped, 5, 'model failure releases the camera');
  assert.equal(failedModel.getStrength(), 0);

  const gestures = [];
  const frames = [];
  const pointerController = context.window.createHandController({
    onGesture: (event) => gestures.push(event.type),
    onFrame: (event) => frames.push(event),
    loadLandmarker: async () => ({ detectForVideo: () => ({ landmarks: sample ? [sample] : [] }) })
  });
  await pointerController.start();
  function pose({ pinch = false, tipY = 0.2 } = {}) {
    const points = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }));
    points[0] = { x: 0.5, y: 0.65 };
    points[5] = { x: 0.45, y: 0.45 };
    points[9] = { x: 0.5, y: 0.45 };
    points[8] = { x: 0.52, y: tipY };
    points[4] = pinch ? { ...points[8] } : { x: 0.8, y: tipY };
    return points;
  }
  for (let i = 0; i < 8; i++) feed(pose());
  assert.equal(gestures.length, 0, 'resting open hand does not trigger');
  const cursor = pointerController.getPointer();
  assert.ok(cursor.x >= 0 && cursor.x <= 1 && cursor.y >= 0 && cursor.y <= 1, 'cursor stays within the therapy area');
  feed(pose({ pinch: true }));
  for (let i = 0; i < 6; i++) feed(pose({ pinch: true }));
  assert.deepEqual(gestures, ['pinch'], 'holding a pinch only wakes the fire once');
  assert.equal(pointerController.getPointer().down, true);
  feed(pose());
  assert.equal(pointerController.getPointer().down, false, 'opening fingers releases the pinch');
  for (let i = 0; i < 6; i++) feed(pose());
  feed(pose({ tipY: 0.4 }));
  assert.deepEqual(gestures, ['pinch', 'tap'], 'lowering the index finger triggers a tap');
  feed(pose({ tipY: 0.4 }));
  assert.equal(gestures.length, 2, 'tap cooldown prevents duplicate input');
  feed(undefined);
  assert.ok(pointerController.getPointer(), 'brief tracking loss keeps the cursor');
  feed(undefined, 240);
  assert.equal(pointerController.getPointer(), null, 'cursor clears after tracking grace period');
  pointerController.stop();
  assert.equal(frames.at(-1).points, null, 'stopping clears preview joints');
  assert.equal(pointerController.getPointer(), null);

  context.navigator.mediaDevices.getUserMedia = async () => { throw { name: 'NotAllowedError' }; };
  const deniedStates = [];
  const deniedController = context.window.createHandController({
    onStateChange: ({ state }) => deniedStates.push(state)
  });
  await deniedController.start();
  assert.equal(deniedStates.at(-1), 'denied', 'permission denial is reported');
  console.log('hand-controller: fanning, pinch, finger tap, cursor, preview cleanup and camera lifecycle checks passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
