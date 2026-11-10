(() => {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;

  window.createMicController = ({ onStateChange } = {}) => {
    const supported = Boolean(
      navigator.mediaDevices
      && typeof navigator.mediaDevices.getUserMedia === 'function'
      && AudioContextClass
    );

    let currentState = 'off';
    let requestId = 0;
    let stream = null;
    let audioContext = null;
    let sourceNode = null;
    let analyserNode = null;
    let timeData = null;
    let frequencyData = null;
    let animationFrame = 0;
    let calibrationEndsAt = 0;
    let calibrationRms = [];
    let calibrationRatios = [];
    let baselineRms = 0.008;
    let baselineRatio = 0.45;
    let targetStrength = 0;
    let blowStrength = 0;
    let lastSampleTime = 0;

    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

    function emit(stateName, message) {
      currentState = stateName;
      onStateChange?.({ state: stateName, message });
    }

    function releaseAudio() {
      cancelAnimationFrame(animationFrame);
      animationFrame = 0;

      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      sourceNode?.disconnect();
      analyserNode?.disconnect();
      if (audioContext && audioContext.state !== 'closed') {
        audioContext.close().catch(() => {});
      }

      stream = null;
      audioContext = null;
      sourceNode = null;
      analyserNode = null;
      timeData = null;
      frequencyData = null;
      targetStrength = 0;
      blowStrength = 0;
    }

    function readRms() {
      analyserNode.getFloatTimeDomainData(timeData);
      let sum = 0;
      for (let i = 0; i < timeData.length; i++) {
        sum += timeData[i] * timeData[i];
      }
      return Math.sqrt(sum / timeData.length);
    }

    function readBroadbandRatio() {
      analyserNode.getByteFrequencyData(frequencyData);
      const binWidth = audioContext.sampleRate / analyserNode.fftSize;
      let lowTotal = 0;
      let lowCount = 0;
      let highTotal = 0;
      let highCount = 0;

      for (let i = 1; i < frequencyData.length; i++) {
        const frequency = i * binWidth;
        const value = frequencyData[i] / 255;
        if (frequency >= 80 && frequency < 1000) {
          lowTotal += value;
          lowCount++;
        } else if (frequency >= 1200 && frequency <= 8000) {
          highTotal += value;
          highCount++;
        }
      }

      const lowMean = lowCount ? lowTotal / lowCount : 0;
      const highMean = highCount ? highTotal / highCount : 0;
      return highMean / (lowMean + highMean + 0.001);
    }

    function finishCalibration() {
      const rmsMean = calibrationRms.reduce((sum, value) => sum + value, 0) / Math.max(1, calibrationRms.length);
      const variance = calibrationRms.reduce((sum, value) => sum + (value - rmsMean) ** 2, 0) / Math.max(1, calibrationRms.length);
      const ratioMean = calibrationRatios.reduce((sum, value) => sum + value, 0) / Math.max(1, calibrationRatios.length);

      baselineRms = Math.max(0.003, rmsMean + Math.sqrt(variance) * 0.5);
      baselineRatio = clamp(ratioMean || 0.45, 0.1, 0.9);
      calibrationRms = [];
      calibrationRatios = [];
      emit('on', '바람을 불어보세요.');
    }

    function analyse(now) {
      if (!analyserNode || !audioContext) return;

      const dt = clamp((now - lastSampleTime) / 1000, 0, 0.1);
      lastSampleTime = now;
      const rms = readRms();
      const broadbandRatio = readBroadbandRatio();

      if (currentState === 'calibrating') {
        calibrationRms.push(rms);
        calibrationRatios.push(broadbandRatio);
        blowStrength = 0;
        if (now >= calibrationEndsAt) finishCalibration();
      } else if (currentState === 'on') {
        const noiseFloor = baselineRms * 1.5 + 0.006;
        const responseRange = Math.max(0.035, baselineRms * 4.5);
        const energy = clamp((rms - noiseFloor) / responseRange, 0, 1);
        const frequencyWeight = clamp((broadbandRatio - baselineRatio + 0.16) / 0.36, 0, 1);
        const candidate = energy * (0.65 + frequencyWeight * 0.35);
        const gatedCandidate = candidate < 0.06 ? 0 : candidate;

        targetStrength += (gatedCandidate - targetStrength) * 0.32;
        const timeConstant = targetStrength > blowStrength ? 0.11 : 0.62;
        const smoothing = 1 - Math.exp(-dt / timeConstant);
        blowStrength += (targetStrength - blowStrength) * smoothing;
        blowStrength = clamp(blowStrength, 0, 1);
      }

      animationFrame = requestAnimationFrame(analyse);
    }

    async function start() {
      if (!supported) {
        emit('unsupported', '이 환경에서는 마이크를 사용할 수 없어요.');
        return;
      }
      if (currentState === 'requesting' || currentState === 'calibrating' || currentState === 'on') return;

      const activeRequest = ++requestId;
      emit('requesting', '마이크 권한을 확인하고 있어요…');

      try {
        // 모바일 브라우저의 사용자 제스처 요구를 지키기 위해
        // ON 버튼 처리 흐름 안에서 오디오 컨텍스트를 먼저 활성화한다.
        audioContext = new AudioContextClass();
        if (audioContext.state === 'suspended') await audioContext.resume();

        const nextStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false
        });

        if (activeRequest !== requestId) {
          nextStream.getTracks().forEach((track) => track.stop());
          return;
        }

        stream = nextStream;
        sourceNode = audioContext.createMediaStreamSource(stream);
        analyserNode = audioContext.createAnalyser();
        analyserNode.fftSize = 2048;
        analyserNode.smoothingTimeConstant = 0.65;
        sourceNode.connect(analyserNode);

        timeData = new Float32Array(analyserNode.fftSize);
        frequencyData = new Uint8Array(analyserNode.frequencyBinCount);
        calibrationRms = [];
        calibrationRatios = [];
        targetStrength = 0;
        blowStrength = 0;
        lastSampleTime = performance.now();
        calibrationEndsAt = lastSampleTime + 1800;

        stream.getTracks().forEach((track) => {
          track.addEventListener('ended', () => {
            if (currentState === 'off') return;
            requestId++;
            releaseAudio();
            emit('unavailable', '사용 가능한 마이크를 찾지 못했어요.');
          }, { once: true });
        });

        emit('calibrating', '주변 소리를 확인하고 있어요…');
        animationFrame = requestAnimationFrame(analyse);
      } catch (error) {
        if (activeRequest !== requestId) return;
        releaseAudio();
        if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
          emit('denied', '마이크 권한이 필요해요.');
        } else if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') {
          emit('unavailable', '사용 가능한 마이크를 찾지 못했어요.');
        } else {
          emit('error', '마이크를 사용할 수 없어요.');
        }
      }
    }

    function stop() {
      requestId++;
      currentState = 'off';
      releaseAudio();
      emit('off', '마이크는 꺼져 있어요.');
    }

    if (!supported) {
      emit('unsupported', '이 환경에서는 마이크를 사용할 수 없어요.');
    }

    return {
      start,
      stop,
      getStrength: () => blowStrength,
      isSupported: () => supported,
      getState: () => currentState
    };
  };
})();
