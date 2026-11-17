(() => {
  const FIRE_LOOP_PATH = './assets/audio/fire-loop.mp3';
  // The strongest visible fire is capped at 1.18 * 1.6 in fire-sketch.js.
  const MAX_FIRE_ENERGY = 1.18 * 1.6;

  window.createSoundController = ({ onStateChange } = {}) => {
    let available = false;
    let checking = true;
    let volume = 0;
    let fireEnergy = 0.78;
    let audioContext = null;
    let gainNode = null;
    let currentGain = 0;
    let loopAudio = null;
    let animationFrame = 0;
    let lastUpdateTime = 0;
    let playbackRequest = 0;

    const emit = (state, message) => onStateChange?.({ state, message });
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

    function prepare() {
      loopAudio = new Audio();
      loopAudio.src = FIRE_LOOP_PATH;
      loopAudio.loop = true;
      loopAudio.preload = 'auto';
      loopAudio.volume = 0;
      loopAudio.playsInline = true;
      loopAudio.setAttribute('playsinline', '');

      const handleError = () => {
        checking = false;
        available = false;
        playbackRequest++;
        volume = 0;
        cancelVolumeUpdate();
        applyGain(0);
        loopAudio?.pause();
        emit('unavailable', '오디오 파일이 준비되지 않았어요.');
      };

      loopAudio.addEventListener('error', handleError, { once: true });
      loopAudio.load();

      // iOS는 사용자 제스처 전 미디어 preload를 보류할 수 있으므로
      // canplay를 기다리지 않고 컨트롤을 연다. 실제 오류는 error/play()로 처리한다.
      checking = false;
      available = true;
      emit('ready', '소리를 켜면 잔잔한 불 소리가 재생돼요.');
    }

    function applyGain(value) {
      currentGain = value;
      if (gainNode) gainNode.gain.value = value;
      else if (loopAudio) loopAudio.volume = value;
    }

    function prepareGain() {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (audioContext || !Context) return;
      // A GainNode also controls volume on mobile Safari, where media.volume
      // may be controlled exclusively by the device's physical volume keys.
      audioContext = new Context();
      const source = audioContext.createMediaElementSource(loopAudio);
      gainNode = audioContext.createGain();
      gainNode.gain.value = 0;
      source.connect(gainNode);
      gainNode.connect(audioContext.destination);
      loopAudio.volume = 1;
    }

    function targetVolume() {
      return volume / 100 * clamp(fireEnergy / MAX_FIRE_ENERGY, 0, 1);
    }

    function cancelVolumeUpdate() {
      cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      lastUpdateTime = 0;
    }

    function updateVolume(now) {
      if (volume === 0 || !loopAudio || loopAudio.paused) {
        cancelVolumeUpdate();
        return;
      }

      const dt = lastUpdateTime ? clamp((now - lastUpdateTime) / 1000, 0, 0.1) : 1 / 60;
      lastUpdateTime = now;
      const target = targetVolume();
      const timeConstant = target > currentGain ? 0.18 : 0.55;
      const smoothing = 1 - Math.exp(-dt / timeConstant);
      applyGain(currentGain + (target - currentGain) * smoothing);
      animationFrame = requestAnimationFrame(updateVolume);
    }

    function startVolumeUpdate() {
      cancelVolumeUpdate();
      animationFrame = requestAnimationFrame(updateVolume);
    }

    async function setVolume(nextVolume) {
      if (!Number.isFinite(nextVolume)) return false;
      const requestedVolume = Math.round(clamp(nextVolume, 0, 100));

      if (requestedVolume === 0) {
        playbackRequest++;
        volume = 0;
        cancelVolumeUpdate();
        if (loopAudio) {
          applyGain(0);
          loopAudio.pause();
        }
        emit('off', '소리는 꺼져 있어요.');
        return true;
      }

      if (checking) {
        emit('checking', '소리를 준비하고 있어요.');
        return false;
      }
      if (!available || !loopAudio) {
        emit('unavailable', '오디오 파일이 준비되지 않았어요.');
        return false;
      }

      const currentRequest = ++playbackRequest;
      volume = requestedVolume;
      try {
        // 사용자 클릭/터치 이벤트의 호출 스택 안에서 play()를 호출해
        // iPhone을 포함한 모바일 브라우저의 autoplay 제한을 지킨다.
        prepareGain();
        const resume = audioContext?.state === 'suspended' ? audioContext.resume() : Promise.resolve();
        await Promise.all([resume, loopAudio.play()]);
        if (currentRequest !== playbackRequest) return false;
        startVolumeUpdate();
        emit('playing', '불길에 맞춰 소리가 잔잔하게 달라져요.');
        return true;
      } catch {
        if (currentRequest !== playbackRequest) return false;
        volume = 0;
        applyGain(0);
        loopAudio.pause();
        cancelVolumeUpdate();
        emit('error', '소리를 재생할 수 없어요.');
        return false;
      }
    }

    function setFireState(energy) {
      if (Number.isFinite(energy)) fireEnergy = clamp(energy, 0, MAX_FIRE_ENERGY);
    }

    prepare();
    return {
      setVolume,
      setFireState,
      getVolume: () => volume,
      isAvailable: () => available,
      isChecking: () => checking
    };
  };
})();
