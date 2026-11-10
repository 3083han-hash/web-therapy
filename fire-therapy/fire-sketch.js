(() => {
  const root = document.documentElement;
  const css = (name) => getComputedStyle(root).getPropertyValue(name).trim();
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

  const state = {
    intensity: 'calm',
    paused: false,
    skipNextDelta: false,
    boost: 0,
    sessionMinutes: 0,
    sessionRemainingMs: null,
    sessionEnded: false,
    endFadeProgress: 0,
    blowStrength: 0,
    strongBlowDuration: 0,
    strongSparkCooldown: 0,
    reducedMotion: motionQuery.matches
  };

  const intensityMap = {
    calm: { label: '잔잔하게', flame: 0.78, sparks: 0.55, speed: 0.78 },
    warm: { label: '따뜻하게', flame: 1.0, sparks: 0.85, speed: 1.0 },
    deep: { label: '깊고 포근하게', flame: 1.18, sparks: 1.15, speed: 1.1 }
  };

  const particles = [];
  let sketchInstance = null;
  let micController = null;
  let lastTimerText = '';

  const sketch = (p) => {
    let wrap;
    let palette;
    let elapsed = 0;
    let resizeObserver = null;
    let pointerStart = null;

    p.setup = () => {
      // setup(): 캔버스 생성 + 픽셀 밀도 + 색상/초기 상태 설정
      wrap = document.getElementById('fire-canvas-wrap');
      const { width, height } = wrap.getBoundingClientRect();
      const canvas = p.createCanvas(Math.max(1, width), Math.max(1, height), p.P2D);
      canvas.parent('fire-canvas');
      p.pixelDensity(Math.min(window.devicePixelRatio || 1, 2));
      p.noStroke();
      p.frameRate(state.reducedMotion ? 24 : 60);

      palette = {
        band: css('--color-band'),
        band2: css('--color-band-2'),
        core: css('--fire-core'),
        mid: css('--fire-mid'),
        outer: css('--color-accent'),
        ember: css('--fire-ember'),
        log: css('--fire-log'),
        logDark: css('--fire-log-dark')
      };

      p.describe('짙은 배경 위에서 장작불이 잔잔하게 흔들리고 작은 불씨가 위로 올라가는 불멍 애니메이션. 화면을 누르면 불꽃이 잠시 커집니다.');
      bindCanvasInput(canvas.elt);

      if ('ResizeObserver' in window) {
        resizeObserver = new ResizeObserver(resizeCanvasToWrap);
        resizeObserver.observe(wrap);
      }

      motionQuery.addEventListener('change', handleMotionPreference);
    };

    p.draw = () => {
      // draw(): deltaTime 기반 애니메이션 갱신 + 전체 화면 렌더링
      const timerDt = state.paused || state.skipNextDelta ? 0 : p.deltaTime / 1000;
      state.skipNextDelta = false;
      const dt = Math.min(timerDt, 0.05);
      elapsed += dt;

      const profile = intensityMap[state.intensity];
      state.boost = Math.max(0, state.boost - dt * 0.55);
      if (!state.paused) {
        state.blowStrength = micController?.getStrength() ?? 0;
      }
      const blowStrength = p.constrain(state.blowStrength, 0, 1);
      if (state.sessionEnded) {
        state.endFadeProgress = Math.min(1, state.endFadeProgress + dt / 3);
      }
      const fadeEase = smoothStep(state.endFadeProgress);
      const sessionFade = 1 - fadeEase * 0.65;
      const restingEnergy = (profile.flame + state.boost) * sessionFade;
      const windEnergy = profile.flame * 0.55 * blowStrength * sessionFade;
      const energy = p.constrain(restingEnergy + windEnergy, 0, profile.flame * 1.6);
      const speed = profile.speed * (1 + blowStrength * 0.25) * (state.reducedMotion ? 0.55 : 1);
      const motionAmount = (state.reducedMotion ? 0.22 : 1) * (1 + blowStrength * 0.22);

      drawBackground(p, palette, elapsed, speed, motionAmount, energy);
      drawGroundGlow(p, palette, energy);
      drawLogs(p, palette);
      drawFlames(p, palette, elapsed, energy, speed, motionAmount);

      if (!state.paused) {
        const sparkAmount = state.reducedMotion ? 0.25 : 1;
        spawnSparks(p, profile.sparks * energy * sparkAmount, dt);
        updateWindSparks(p, blowStrength, dt);
        updateParticles(dt, speed);
      }
      drawParticles(p, palette);

      if (state.paused) drawPauseVeil(p);
      advanceTimer(timerDt);
    };

    p.windowResized = () => {
      resizeCanvasToWrap();
    };

    function bindCanvasInput(canvasElement) {
      canvasElement.addEventListener('pointerdown', (event) => {
        if (!event.isPrimary) return;
        pointerStart = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY
        };
      });

      canvasElement.addEventListener('pointerup', (event) => {
        if (!pointerStart || pointerStart.id !== event.pointerId) return;
        const distance = Math.hypot(
          event.clientX - pointerStart.x,
          event.clientY - pointerStart.y
        );
        pointerStart = null;
        if (distance <= 12) wakeFire();
      });

      canvasElement.addEventListener('pointercancel', () => {
        pointerStart = null;
      });

      wrap.addEventListener('keydown', (event) => {
        if (event.repeat || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        wakeFire();
      });
    }

    function resizeCanvasToWrap() {
      const { width, height } = wrap.getBoundingClientRect();
      const nextWidth = Math.max(1, Math.round(width));
      const nextHeight = Math.max(1, Math.round(height));
      if (nextWidth !== p.width || nextHeight !== p.height) {
        p.resizeCanvas(nextWidth, nextHeight);
        if (state.paused) p.redraw();
      }
    }

    function handleMotionPreference(event) {
      state.reducedMotion = event.matches;
      p.frameRate(state.reducedMotion ? 24 : 60);
      if (state.paused) p.redraw();
    }

    function wakeFire() {
      if (state.paused) return;
      state.boost = Math.min(0.65, state.boost + 0.28);
      const burstCount = state.reducedMotion ? 2 : 6;
      for (let i = 0; i < burstCount; i++) particles.push(makeParticle(p, true));
      setStatus('불씨가 살짝 살아났어요.');
    }
  };

  function drawBackground(p, palette, t, speed, motionAmount, energy) {
    const ctx = p.drawingContext;
    const grad = ctx.createLinearGradient(0, 0, 0, p.height);
    grad.addColorStop(0, palette.band2);
    grad.addColorStop(1, palette.band);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, p.width, p.height);

    // 아주 느린 주변광. 반복적인 큰 모션 대신 거의 고정된 숨결처럼 움직임.
    const pulse = 0.5 + Math.sin(t * 0.8 * speed) * 0.04 * motionAmount;
    ctx.save();
    ctx.globalAlpha = 0.07 + pulse * 0.025 + Math.max(0, energy - 0.75) * 0.018;
    const rg = ctx.createRadialGradient(p.width * 0.5, p.height * 0.72, 0, p.width * 0.5, p.height * 0.72, p.width * 0.48);
    rg.addColorStop(0, palette.outer);
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, p.width, p.height);
    ctx.restore();
  }

  function drawGroundGlow(p, palette, energy) {
    const ctx = p.drawingContext;
    const cx = p.width * 0.5;
    const cy = p.height * 0.79;
    ctx.save();
    ctx.globalAlpha = 0.08 + 0.07 * energy;
    const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(p.width, p.height) * 0.34);
    rg.addColorStop(0, palette.mid);
    rg.addColorStop(0.36, palette.outer);
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, p.width, p.height);
    ctx.restore();
  }

  function drawLogs(p, palette) {
    const cx = p.width * 0.5;
    const baseY = p.height * 0.78;
    const size = Math.min(p.width, p.height);
    const logW = size * 0.34;
    const logH = Math.max(20, size * 0.052);

    p.push();
    p.translate(cx, baseY);

    drawOneLog(p, -logW * 0.05, 0, logW, logH, -0.18, palette);
    drawOneLog(p, logW * 0.05, 0, logW, logH, 0.18, palette);

    p.pop();
  }

  function drawOneLog(p, x, y, w, h, angle, palette) {
    p.push();
    p.translate(x, y);
    p.rotate(angle);
    p.fill(palette.logDark);
    p.rectMode(p.CENTER);
    p.rect(0, h * 0.14, w, h, h * 0.48);
    p.fill(palette.log);
    p.rect(0, -h * 0.12, w * 0.92, h * 0.54, h * 0.28);
    p.fill(palette.logDark);
    p.circle(w * 0.43, 0, h * 0.72);
    p.noFill();
    p.stroke(palette.log);
    p.strokeWeight(Math.max(1, h * 0.09));
    p.circle(w * 0.43, 0, h * 0.36);
    p.noStroke();
    p.pop();
  }

  function drawFlames(p, palette, t, energy, speed, motionAmount) {
    const cx = p.width * 0.5;
    const baseY = p.height * 0.765;
    const size = Math.min(p.width, p.height);

    const outerH = size * 0.44 * energy;
    const midH = size * 0.34 * energy;
    const coreH = size * 0.22 * energy;

    const irregular = p.noise(t * 0.72 * speed + 14.7) - 0.5;
    const sway = (
      Math.sin(t * 1.8 * speed) * size * 0.012
      + irregular * size * 0.016
    ) * motionAmount;
    const breathe = 1 + (
      Math.sin(t * 2.1 * speed) * 0.025
      + irregular * 0.07
    ) * motionAmount;

    drawFlameShape(p, cx + sway, baseY, size * 0.28 * breathe, outerH * breathe, palette.outer, t, 0.0, motionAmount);
    drawFlameShape(p, cx - sway * 0.3, baseY + 4, size * 0.20 * breathe, midH * breathe, palette.mid, t, 1.7, motionAmount);
    drawFlameShape(p, cx + sway * 0.2, baseY + 9, size * 0.11 * breathe, coreH * breathe, palette.core, t, 3.1, motionAmount);
  }

  function drawFlameShape(p, cx, baseY, w, h, fillColor, t, phase, motionAmount) {
    const lean = Math.sin(t * 2.4 + phase) * w * 0.18 * motionAmount;
    const flutter = Math.sin(t * 4.2 + phase) * h * 0.025 * motionAmount;

    p.fill(fillColor);
    p.beginShape();
    p.vertex(cx - w * 0.5, baseY);

    // p5.js 2.x: 3차 Bézier 한 구간은 제어점 2개와 끝점의
    // 세 좌표를 각각 bezierVertex(x, y)로 추가한다.
    addCubicSegment(p,
      cx - w * 0.62, baseY - h * 0.18,
      cx - w * 0.28, baseY - h * 0.43,
      cx - w * 0.18 + lean, baseY - h * 0.62
    );
    addCubicSegment(p,
      cx - w * 0.05 + lean, baseY - h * 0.82,
      cx + w * 0.03 + lean, baseY - h + flutter,
      cx + lean, baseY - h
    );
    addCubicSegment(p,
      cx + w * 0.22 + lean, baseY - h * 0.74,
      cx + w * 0.46, baseY - h * 0.46,
      cx + w * 0.5, baseY - h * 0.22
    );
    addCubicSegment(p,
      cx + w * 0.58, baseY - h * 0.05,
      cx + w * 0.34, baseY,
      cx + w * 0.18, baseY
    );
    p.endShape(p.CLOSE);
  }

  function addCubicSegment(p, c1x, c1y, c2x, c2y, endX, endY) {
    p.bezierVertex(c1x, c1y);
    p.bezierVertex(c2x, c2y);
    p.bezierVertex(endX, endY);
  }

  function smoothStep(value) {
    return value * value * (3 - 2 * value);
  }

  function spawnSparks(p, strength, dt) {
    const rate = 3.2 * strength;
    if (Math.random() < rate * dt) particles.push(makeParticle(p, false));
  }

  function updateWindSparks(p, blowStrength, dt) {
    if (blowStrength > 0.72) {
      state.strongBlowDuration += dt;
    } else {
      state.strongBlowDuration = Math.max(0, state.strongBlowDuration - dt * 1.5);
    }

    state.strongSparkCooldown = Math.max(0, state.strongSparkCooldown - dt);
    if (state.strongBlowDuration < 0.65 || state.strongSparkCooldown > 0) return;

    const sparkCount = blowStrength > 0.9 && !state.reducedMotion ? 2 : 1;
    for (let i = 0; i < sparkCount; i++) particles.push(makeParticle(p, false));
    state.strongSparkCooldown = 0.5 + p.random(0.35);
  }

  function makeParticle(p, burst) {
    const size = Math.min(p.width, p.height);
    return {
      x: p.width * 0.5 + (Math.random() - 0.5) * size * (burst ? 0.18 : 0.08),
      y: p.height * 0.69 + Math.random() * size * 0.05,
      vx: (Math.random() - 0.5) * size * (burst ? 0.09 : 0.035),
      vy: -size * (burst ? 0.24 : 0.13) * (0.7 + Math.random() * 0.7),
      life: 1,
      decay: burst ? 0.72 + Math.random() * 0.45 : 0.5 + Math.random() * 0.35,
      r: size * (0.0025 + Math.random() * 0.0035)
    };
  }

  function updateParticles(dt, speed) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const q = particles[i];
      q.x += q.vx * dt * speed;
      q.y += q.vy * dt * speed;
      q.vx *= 0.992;
      q.life -= q.decay * dt;
      if (q.life <= 0) particles.splice(i, 1);
    }
  }

  function drawParticles(p, palette) {
    p.push();
    p.noStroke();
    for (const q of particles) {
      p.fill(`${palette.ember}${alphaHex(Math.max(0, Math.min(1, q.life)) * 0.9)}`);
      p.circle(q.x, q.y, q.r * (0.7 + q.life * 0.8));
    }
    p.pop();
  }

  function alphaHex(a) {
    return Math.round(a * 255).toString(16).padStart(2, '0');
  }

  function drawPauseVeil(p) {
    p.push();
    p.fill('rgba(0,0,0,0.12)');
    p.rect(0, 0, p.width, p.height);
    p.pop();
  }

  const micValue = document.getElementById('mic-value');
  const micStatus = document.getElementById('mic-status');
  const micOffBtn = document.getElementById('mic-off-btn');
  const micOnBtn = document.getElementById('mic-on-btn');

  micController = window.createMicController({
    onStateChange: updateMicUI
  });

  sketchInstance = new p5(sketch);

  const intensityValue = document.getElementById('intensity-value');
  document.querySelectorAll('.segment-btn').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.segment-btn').forEach((b) => {
        b.classList.toggle('is-selected', b === button);
        b.setAttribute('aria-pressed', String(b === button));
      });
      state.intensity = button.dataset.level;
      intensityValue.textContent = intensityMap[state.intensity].label;
      setStatus(`불의 세기를 ${intensityMap[state.intensity].label} 바꿨어요.`);
    });
  });

  const timerLabel = document.getElementById('timer-label');
  document.querySelectorAll('.timer-btn').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.timer-btn').forEach((b) => {
        b.classList.toggle('is-selected', b === button);
        b.setAttribute('aria-pressed', String(b === button));
      });
      state.sessionMinutes = Number(button.dataset.minutes);
      state.sessionRemainingMs = state.sessionMinutes > 0 ? state.sessionMinutes * 60_000 : null;
      state.sessionEnded = false;
      state.endFadeProgress = 0;
      setTimerText(state.sessionMinutes > 0 ? `${state.sessionMinutes}:00` : '자유롭게');
      setStatus(state.sessionMinutes > 0 ? `${state.sessionMinutes}분 동안 천천히 머물러보세요.` : '시간을 정하지 않고 편하게 머물러보세요.');
    });
  });

  const pauseBtn = document.getElementById('pause-btn');
  pauseBtn.addEventListener('click', () => {
    state.paused = !state.paused;
    state.skipNextDelta = !state.paused;
    pauseBtn.setAttribute('aria-pressed', String(state.paused));
    pauseBtn.innerHTML = state.paused
      ? '<span class="button-icon" aria-hidden="true">▶</span>다시 이어보기'
      : '<span class="button-icon" aria-hidden="true">Ⅱ</span>잠시 멈추기';
    setStatus(state.paused ? '불꽃을 잠시 멈췄어요.' : '다시 천천히 바라봐요.');
    if (state.paused) {
      sketchInstance.noLoop();
      sketchInstance.redraw();
    } else {
      sketchInstance.loop();
    }
  });

  micOnBtn.addEventListener('click', () => {
    micController.start();
  });

  micOffBtn.addEventListener('click', () => {
    micController.stop();
  });

  window.addEventListener('pagehide', () => {
    micController.stop();
  });

  document.getElementById('reset-btn').addEventListener('click', () => {
    state.paused = false;
    state.boost = 0;
    state.intensity = 'calm';
    state.sessionMinutes = 0;
    state.sessionRemainingMs = null;
    state.sessionEnded = false;
    state.endFadeProgress = 0;
    state.strongBlowDuration = 0;
    state.strongSparkCooldown = 0;
    state.skipNextDelta = true;
    particles.splice(0, particles.length);

    document.querySelectorAll('.segment-btn').forEach((b) => {
      const selected = b.dataset.level === 'calm';
      b.classList.toggle('is-selected', selected);
      b.setAttribute('aria-pressed', String(selected));
    });
    document.querySelectorAll('.timer-btn').forEach((b) => {
      const selected = b.dataset.minutes === '0';
      b.classList.toggle('is-selected', selected);
      b.setAttribute('aria-pressed', String(selected));
    });

    intensityValue.textContent = '잔잔하게';
    setTimerText('자유롭게');
    pauseBtn.setAttribute('aria-pressed', 'false');
    pauseBtn.innerHTML = '<span class="button-icon" aria-hidden="true">Ⅱ</span>잠시 멈추기';
    sketchInstance.loop();
    setStatus('불이 잔잔하게 타고 있어요.');
  });

  function advanceTimer(dt) {
    if (state.sessionRemainingMs === null || state.sessionEnded || state.paused) return;
    state.sessionRemainingMs = Math.max(0, state.sessionRemainingMs - dt * 1000);
    const totalSec = Math.ceil(state.sessionRemainingMs / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    setTimerText(`${min}:${String(sec).padStart(2, '0')}`);

    if (state.sessionRemainingMs <= 0) {
      state.sessionEnded = true;
      state.sessionRemainingMs = null;
      state.endFadeProgress = 0;
      setTimerText('마무리');
      setStatus('정해둔 시간이 끝났어요. 불꽃이 천천히 잦아듭니다.');
    }
  }

  function setTimerText(text) {
    if (text === lastTimerText) return;
    timerLabel.textContent = text;
    lastTimerText = text;
  }

  function updateMicUI({ state: micState, message }) {
    const active = micState === 'requesting' || micState === 'calibrating' || micState === 'on';
    const unsupported = micState === 'unsupported';

    micValue.textContent = active ? 'ON' : 'OFF';
    micStatus.textContent = message;
    micOnBtn.classList.toggle('is-selected', active);
    micOffBtn.classList.toggle('is-selected', !active);
    micOnBtn.setAttribute('aria-pressed', String(active));
    micOffBtn.setAttribute('aria-pressed', String(!active));
    micOnBtn.disabled = unsupported || active;
    micOffBtn.disabled = unsupported || !active;
  }

  let statusTimer = 0;
  function setStatus(message) {
    const el = document.getElementById('status-text');
    el.textContent = message;
    clearTimeout(statusTimer);
    statusTimer = window.setTimeout(() => {
      if (!state.paused && !state.sessionEnded) el.textContent = defaultStatusText();
    }, 3200);
  }

  function defaultStatusText() {
    if (state.intensity === 'warm') return '불이 따뜻하게 타고 있어요.';
    if (state.intensity === 'deep') return '불이 깊고 포근하게 타고 있어요.';
    return '불이 잔잔하게 타고 있어요.';
  }
})();
