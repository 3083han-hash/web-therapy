(() => {
  const paths = {
    loop: './assets/audio/fire-loop-soft.mp3',
    crackles: [
      './assets/audio/fire-crackle-1.mp3',
      './assets/audio/fire-crackle-2.mp3'
    ],
    ambience: './assets/audio/night-ambience.mp3'
  };

  window.createSoundController = ({ onStateChange } = {}) => {
    let available = false;
    let checking = true;
    let level = 'off';
    let intensity = 'calm';
    let blowStrength = 0;
    let loopAudio = null;
    let ambienceAudio = null;
    let crackleAudios = [];
    let animationFrame = 0;
    let crackleTimer = 0;

    const emit = (state, message) => onStateChange?.({ state, message });
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

    async function exists(path) {
      try {
        const response = await fetch(path, { method: 'HEAD', cache: 'no-store' });
        return response.ok;
      } catch {
        return false;
      }
    }

    async function prepare() {
      const [hasLoop, hasAmbience, ...crackles] = await Promise.all([
        exists(paths.loop),
        exists(paths.ambience),
        ...paths.crackles.map(exists)
      ]);
      checking = false;
      available = hasLoop;
      if (!available) {
        emit('unavailable', '오디오 파일이 준비되지 않았어요.');
        return;
      }

      loopAudio = new Audio(paths.loop);
      loopAudio.loop = true;
      loopAudio.preload = 'auto';
      loopAudio.volume = 0;

      if (hasAmbience) {
        ambienceAudio = new Audio(paths.ambience);
        ambienceAudio.loop = true;
        ambienceAudio.preload = 'auto';
        ambienceAudio.volume = 0;
      }
      crackleAudios = paths.crackles
        .filter((_, index) => crackles[index])
        .map((path) => {
          const audio = new Audio(path);
          audio.preload = 'auto';
          return audio;
        });
      emit('ready', '소리를 켜면 잔잔한 불 소리가 재생돼요.');
    }

    function targetVolumes() {
      const levelVolume = level === 'soft' ? 0.18 : level === 'normal' ? 0.3 : 0;
      const intensityScale = intensity === 'deep' ? 1.12 : intensity === 'warm' ? 1 : 0.78;
      return {
        loop: clamp(levelVolume * intensityScale * (1 + blowStrength * 0.1), 0, 0.38),
        ambience: level === 'off' ? 0 : level === 'soft' ? 0.025 : 0.04
      };
    }

    function updateVolumes() {
      if (level === 'off' || !loopAudio) return;
      const targets = targetVolumes();
      loopAudio.volume += (targets.loop - loopAudio.volume) * 0.04;
      if (ambienceAudio) ambienceAudio.volume += (targets.ambience - ambienceAudio.volume) * 0.025;
      animationFrame = requestAnimationFrame(updateVolumes);
    }

    function scheduleCrackle() {
      clearTimeout(crackleTimer);
      if (level === 'off' || !crackleAudios.length) return;
      const intensityDelay = intensity === 'deep' ? 0.78 : intensity === 'warm' ? 0.9 : 1.12;
      const windDelay = 1 - blowStrength * 0.18;
      crackleTimer = window.setTimeout(() => {
        if (level !== 'off') {
          const audio = crackleAudios[Math.floor(Math.random() * crackleAudios.length)];
          audio.currentTime = 0;
          audio.volume = level === 'soft' ? 0.08 : 0.13;
          audio.play().catch(() => {});
          scheduleCrackle();
        }
      }, (4200 + Math.random() * 5200) * intensityDelay * windDelay);
    }

    async function setLevel(nextLevel) {
      if (nextLevel === 'off') {
        level = 'off';
        cancelAnimationFrame(animationFrame);
        clearTimeout(crackleTimer);
        [loopAudio, ambienceAudio, ...crackleAudios].filter(Boolean).forEach((audio) => {
          audio.pause();
          audio.currentTime = 0;
          audio.volume = 0;
        });
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

      level = nextLevel;
      try {
        await loopAudio.play();
        if (ambienceAudio) await ambienceAudio.play();
        cancelAnimationFrame(animationFrame);
        animationFrame = requestAnimationFrame(updateVolumes);
        scheduleCrackle();
        emit('playing', nextLevel === 'soft' ? '불 소리를 작게 들려드려요.' : '불 소리를 들려드려요.');
        return true;
      } catch {
        level = 'off';
        emit('error', '소리를 재생할 수 없어요.');
        return false;
      }
    }

    function setFireState(nextIntensity, nextBlowStrength) {
      intensity = nextIntensity;
      blowStrength = clamp(nextBlowStrength, 0, 1);
    }

    prepare();
    return {
      setLevel,
      setFireState,
      isAvailable: () => available,
      isChecking: () => checking
    };
  };
})();
