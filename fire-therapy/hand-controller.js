(() => {
  // Match the working loader in yongho2157.github.io/js/hands.js.
  const VERSION = '0.10.14';
  const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
  const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

  // Tune these values after testing with a real camera and hand.
  const TUNING = {
    trackingFps: 15,
    minStroke: 0.065,
    minReversalMs: 170,
    maxReversalMs: 1100,
    activityTimeoutMs: 750,
    slowSpeed: 0.16,
    fastSpeed: 0.85,
    riseSeconds: 0.16,
    fallSeconds: 0.65
  };
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const GUIDE = '검지를 까딱하거나 엄지와 검지를 붙여 불씨를 깨워보세요. 위아래로 부채질해도 좋아요.';

  // One Euro filter from the reference: steady at rest, responsive in motion.
  function oneEuro(minCut, beta, dCut) {
    let previous = null, derivative = 0, previousTime = 0;
    const alpha = (cut, dt) => {
      const r = 2 * Math.PI * cut * dt;
      return r / (r + 1);
    };
    return (value, now) => {
      if (previous === null) { previous = value; previousTime = now; return value; }
      const dt = Math.max(0.001, (now - previousTime) / 1000);
      previousTime = now;
      derivative += alpha(dCut, dt) * ((value - previous) / dt - derivative);
      previous += alpha(minCut + beta * Math.abs(derivative), dt) * (value - previous);
      return previous;
    };
  }

  window.createHandController = ({ onStateChange, onGesture, onFrame, videoElement, loadLandmarker } = {}) => {
    const supported = Boolean(navigator.mediaDevices?.getUserMedia);
    const video = videoElement || document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    let stream = null;
    let landmarker = null;
    let loadingLandmarker = null;
    let requestId = 0;
    let enabled = false;
    let frame = 0;
    let lastDetectionAt = 0;
    let lastVideoTime = -1;
    let lastUpdateAt = 0;
    let state = 'off';
    let lastMessage = '';
    let smoothedY = null;
    let anchor = null;
    let extreme = null;
    let direction = 0;
    let lastTurnAt = 0;
    let reversalCount = 0;
    let lastActiveAt = 0;
    let targetStrength = 0;
    let fanningStrength = 0;
    let pointer = null;
    let gesture = null;
    let lastSeenAt = 0;

    function resetPointer() {
      pointer = null;
      gesture = null;
      lastSeenAt = 0;
    }

    function updatePointer(points, now) {
      // Reference uses a 200 ms grace period for brief tracking dropouts.
      if (!points) {
        if (now - lastSeenAt > 200) resetPointer();
        return;
      }
      lastSeenAt = now;
      const vw = video.videoWidth || 640, vh = video.videoHeight || 480;
      const joints = points.map((point) => ({ x: point.x * vw, y: point.y * vh }));
      const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      const palmRaw = Math.max(1, distance(joints[0], joints[9]));
      if (!gesture) gesture = { palm: palmRaw, fx: oneEuro(1.5, 0.008, 1), fy: oneEuro(1.5, 0.008, 1), history: [], down: false, pinchAt: now, cooldown: 0, time: now, velocity: 0 };
      const g = gesture;
      g.palm += (palmRaw - g.palm) * 0.15;
      const pinch = distance(joints[4], joints[8]) / g.palm;
      const ax = joints[9].x - joints[0].x, ay = joints[9].y - joints[0].y;
      const length = Math.hypot(ax, ay) || 1;
      const rawX = ((joints[5].x + joints[9].x) / 2 + ax / length * 0.8 * g.palm) / vw;
      const rawY = ((joints[5].y + joints[9].y) / 2 + ay / length * 0.8 * g.palm) / vh;
      // Use the reference's pixel-scale filter before normalizing to the canvas.
      pointer = { x: g.fx(clamp((1 - rawX - 0.12) / 0.76, 0, 1) * vw, now) / vw,
        y: g.fy(clamp((rawY - 0.1) / 0.8, 0, 1) * vh, now) / vh, down: g.down };
      const rawTip = (joints[8].y - joints[5].y) / g.palm;
      const previous = g.tip;
      g.tip = previous === undefined ? rawTip : previous + (rawTip - previous) * 0.6;
      const dt = Math.max(0.008, (now - g.time) / 1000);
      g.time = now;
      g.velocity = g.velocity * 0.4 + (previous === undefined ? 0 : (g.tip - previous) / dt) * 0.6;
      g.history.push({ time: now, tip: g.tip });
      g.history = g.history.filter((entry) => now - entry.time <= 300);
      if (!g.down && pinch < 0.33) {
        g.down = true;
        g.pinchAt = now;
        onGesture?.({ type: 'pinch', ...pointer });
      } else if (g.down && pinch > 0.48) {
        g.down = false;
        g.pinchAt = now;
      } else if (!g.down && pinch > 0.6 && now - g.pinchAt > 300 && now > g.cooldown && g.velocity > 0.9) {
        const top = g.history.filter((entry) => now - entry.time <= 250).reduce((best, entry) => !best || entry.tip < best.tip ? entry : best, null);
        if (top && g.tip - top.tip > 0.11) {
          onGesture?.({ type: 'tap', ...pointer });
          g.cooldown = now + 320;
          g.history = [];
        }
      }
      pointer.down = g.down || now < g.cooldown - 210;
    }

    function emit(nextState, message) {
      if (state === nextState && lastMessage === message) return;
      state = nextState;
      lastMessage = message;
      onStateChange?.({ state: nextState, message });
    }

    function resetMotion() {
      smoothedY = null;
      anchor = null;
      extreme = null;
      direction = 0;
      lastTurnAt = 0;
      reversalCount = 0;
      lastActiveAt = 0;
      targetStrength = 0;
    }

    function releaseCamera() {
      cancelAnimationFrame(frame);
      frame = 0;
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      video.pause();
      video.srcObject = null;
      lastVideoTime = -1;
      lastDetectionAt = 0;
      lastUpdateAt = 0;
      resetMotion();
      resetPointer();
      onFrame?.({ points: null, pointer: null });
      fanningStrength = 0;
    }

    function stop(message = '손동작은 꺼져 있어요.') {
      enabled = false;
      requestId++;
      releaseCamera();
      emit('off', message);
    }

    function palmCenter(points) {
      // Wrist and four finger-base joints are steadier than fingertip landmarks.
      const joints = [0, 5, 9, 13, 17];
      const x = joints.reduce((sum, i) => sum + points[i].x, 0) / joints.length;
      const y = joints.reduce((sum, i) => sum + points[i].y, 0) / joints.length;
      const span = Math.hypot(points[0].x - points[9].x, points[0].y - points[9].y);
      return { x, y, span };
    }

    function analyse(points, now) {
      if (!points) {
        resetMotion();
        emit('no-hand', '손이 보이지 않아요.');
        return;
      }
      const point = palmCenter(points);
      if (!Number.isFinite(point.y)) return;
      smoothedY = smoothedY === null ? point.y : smoothedY + (point.y - smoothedY) * 0.4;
      const current = { x: point.x, y: smoothedY, span: point.span, at: now };
      if (!anchor) {
        anchor = current;
        extreme = current;
        emit('still', GUIDE);
        return;
      }

      const threshold = Math.max(TUNING.minStroke, current.span * 0.45);
      const travel = current.y - anchor.y;
      if (!direction && Math.abs(travel) >= threshold) {
        direction = Math.sign(travel);
        extreme = current;
        return;
      }
      if (!direction) return;
      if ((current.y - extreme.y) * direction > 0) {
        extreme = current;
      } else if (Math.abs(current.y - extreme.y) >= threshold) {
        const distance = Math.abs(extreme.y - anchor.y);
        const elapsed = now - anchor.at;
        const interval = now - lastTurnAt;
        const vertical = distance >= threshold && Math.abs(extreme.x - anchor.x) <= distance * 0.8;
        const stableScale = Math.abs(extreme.span - anchor.span) <= Math.max(anchor.span, 0.01) * 0.3;
        const valid = vertical && stableScale && elapsed >= TUNING.minReversalMs && elapsed <= TUNING.maxReversalMs;
        reversalCount = valid && (!lastTurnAt || interval <= TUNING.maxReversalMs) ? reversalCount + 1 : 0;
        if (reversalCount >= 2) {
          const speed = distance / (elapsed / 1000);
          targetStrength = clamp(0.2 + (speed - TUNING.slowSpeed) / (TUNING.fastSpeed - TUNING.slowSpeed) * 0.8, 0.2, 1);
          lastActiveAt = now;
          emit(targetStrength >= 0.7 ? 'fast' : 'slow', targetStrength >= 0.7 ? '빠르게 부채질하고 있어요.' : '천천히 부채질하고 있어요.');
        }
        lastTurnAt = now;
        anchor = extreme;
        direction *= -1;
        extreme = current;
      }
      if (lastActiveAt && now - lastActiveAt > TUNING.activityTimeoutMs) {
        targetStrength = 0;
        emit('still', GUIDE);
      } else if (!lastActiveAt) {
        emit('still', GUIDE);
      }
    }

    function tick(now) {
      if (!enabled || !stream || document.hidden) return;
      const dt = lastUpdateAt ? clamp((now - lastUpdateAt) / 1000, 0, 0.1) : 1 / 60;
      lastUpdateAt = now;
      if (lastActiveAt && now - lastActiveAt > TUNING.activityTimeoutMs) targetStrength = 0;
      const seconds = targetStrength > fanningStrength ? TUNING.riseSeconds : TUNING.fallSeconds;
      fanningStrength += (targetStrength - fanningStrength) * (1 - Math.exp(-dt / seconds));
      if (now - lastDetectionAt >= 1000 / TUNING.trackingFps && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
        lastDetectionAt = now;
        lastVideoTime = video.currentTime;
        try {
          const points = landmarker.detectForVideo(video, now).landmarks?.[0];
          updatePointer(points, now);
          analyse(points, now);
          onFrame?.({ points: points || null, pointer });
        } catch {
          stop();
          emit('error', '손동작을 인식할 수 없어요.');
          return;
        }
      }
      frame = requestAnimationFrame(tick);
    }

    async function createLandmarker() {
      const { FilesetResolver, HandLandmarker } = await import(`${CDN}/vision_bundle.mjs`);
      const vision = await FilesetResolver.forVisionTasks(`${CDN}/wasm`);
      const options = (delegate) => HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode: 'VIDEO',
        numHands: 1
      });
      try {
        return await options('GPU');
      } catch {
        return options('CPU');
      }
    }

    async function start() {
      if (!supported) {
        emit('unsupported', '이 브라우저에서는 카메라를 사용할 수 없어요.');
        return;
      }
      if (enabled) return;
      enabled = true;
      const currentRequest = ++requestId;
      emit('requesting', '카메라 권한을 확인하고 있어요.');
      try {
        // Called directly by the ON button; audio is never started here.
        const nextStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 24 } } });
        if (currentRequest !== requestId) {
          nextStream.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = nextStream;
        stream.getVideoTracks().forEach((track) => track.addEventListener('ended', () => {
          if (!enabled) return;
          stop();
          emit('unavailable', '카메라 연결이 끊어졌어요.');
        }, { once: true }));
        video.srcObject = stream;
        await video.play();
        if (currentRequest !== requestId) return;
        emit('loading', '손동작 인식을 준비하고 있어요.');
        if (!landmarker) {
          loadingLandmarker ||= (loadLandmarker || createLandmarker)();
          try {
            landmarker = await loadingLandmarker;
          } finally {
            loadingLandmarker = null;
          }
        }
        if (currentRequest !== requestId) return;
        resetMotion();
        emit('no-hand', '손을 카메라에 보여주세요.');
        frame = requestAnimationFrame(tick);
      } catch (error) {
        if (currentRequest !== requestId) return;
        stop();
        const name = error?.name;
        if (name === 'NotAllowedError' || name === 'SecurityError') emit('denied', '카메라 권한이 필요해요.');
        else if (name === 'NotFoundError' || name === 'OverconstrainedError') emit('unavailable', '사용할 수 있는 카메라가 없어요.');
        else emit('error', '손동작을 준비하지 못했어요. 인터넷 연결을 확인하고 다시 켜주세요.');
      }
    }

    function onVisibilityChange() {
      if (!document.hidden || !enabled) return;
      // Release the camera in background. The user can explicitly turn it on again.
      stop('손동작이 꺼졌어요. 다시 켜서 이어가세요.');
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener?.('pagehide', () => stop());

    return { start, stop, getStrength: () => fanningStrength, getPointer: () => pointer, isSupported: () => supported };
  };
})();
