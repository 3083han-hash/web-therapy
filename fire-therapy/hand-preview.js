// Camera imagery stays in the video element; all joint graphics use p5 P2D.
(() => {
  const BONES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
  window.createHandPreview = () => {
    let points = null, pointer = null, ready = false;
    const host = document.getElementById('hand-preview-overlay');
    const instance = new p5((p) => {
      const resize = () => {
        const width = Math.max(1, host.clientWidth);
        const height = Math.max(1, host.clientHeight);
        if (p.width !== width || p.height !== height) {
          p.resizeCanvas(width, height, true);
          p.redraw();
        }
      };
      p.setup = () => {
        p.createCanvas(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight), p.P2D).parent(host);
        p.pixelDensity(Math.min(window.devicePixelRatio || 1, 2));
        p.noLoop();
        ready = true;
        if ('ResizeObserver' in window) new ResizeObserver(resize).observe(host);
      };
      p.windowResized = resize;
      p.draw = () => {
        p.clear();
        if (!points) return;
        const color = getComputedStyle(document.documentElement)
          .getPropertyValue(pointer?.down ? '--fire-core' : '--color-band-ink').trim();
        p.stroke(color);
        p.strokeWeight(1.5);
        BONES.forEach(([a, b]) => p.line((1 - points[a].x) * p.width, points[a].y * p.height, (1 - points[b].x) * p.width, points[b].y * p.height));
        p.noStroke();
        p.fill(color);
        [4,8,12,16,20].forEach((i) => p.circle((1 - points[i].x) * p.width, points[i].y * p.height, 5));
      };
    });
    return { update: (frame) => {
      points = frame.points;
      pointer = frame.pointer;
      if (ready) instance.redraw();
    } };
  };
})();
