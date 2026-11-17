// Live camera pictures (the same file is in ui/ and web/; a test keeps them equal).
//
// The module relays each camera's H.264 as fragmented MP4 in UI messages (no transcoding). Each camera plays in
// its own <video> through Media Source Extensions; the page puts that element in the camera's tile and keeps
// it there across redraws, so the picture never restarts. The page says which cameras it shows; the module
// stops sending a camera nobody asks for.

const ASK_MS = 5000;

// A classic script (module frames are sandboxed, so an ES module import would be a cross-origin load).
window.createVideo = function createVideo(rcs) {
  /** camera id → player */
  const players = new Map();
  let asked = '';
  let askedAt = 0;
  let wanted = [];

  function player(cam) {
    let p = players.get(cam);
    if (p) return p;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.className = 'cam-video';
    p = { cam, video, ms: null, sb: null, url: '', mime: '', queue: [], parts: new Map() };
    players.set(cam, p);
    return p;
  }

  function closePlayer(p) {
    p.video.removeAttribute('src');
    p.video.load();
    p.video.remove();
    if (p.url) URL.revokeObjectURL(p.url);
    players.delete(p.cam);
  }

  function open(p, mime, data) {
    if (p.url) URL.revokeObjectURL(p.url);
    p.mime = mime;
    p.queue = [data];
    p.sb = null;
    p.ms = null;
    if (!window.MediaSource || !MediaSource.isTypeSupported(mime)) {
      p.unsupported = true;
      return;
    }
    const ms = new MediaSource();
    p.ms = ms;
    p.url = URL.createObjectURL(ms);
    ms.addEventListener(
      'sourceopen',
      () => {
        if (p.ms !== ms) return;
        try {
          p.sb = ms.addSourceBuffer(mime);
          p.sb.mode = 'segments';
          p.sb.addEventListener('updateend', () => pump(p));
          pump(p);
        } catch {}
      },
      { once: true }
    );
    p.video.src = p.url;
  }

  function pump(p) {
    const sb = p.sb;
    if (!sb || sb.updating || !p.queue.length) return;
    const b = sb.buffered;
    if (b.length && p.video.currentTime - b.start(0) > 10) {
      try {
        sb.remove(b.start(0), p.video.currentTime - 4);
        return;
      } catch {}
    }
    try {
      sb.appendBuffer(p.queue.shift());
    } catch {
      p.queue = [];
    }
  }

  function onMessage(m) {
    if (m?.type !== 'video' || !wanted.includes(m.cam)) return;
    const p = player(m.cam);
    const id = `${m.kind}:${m.seq}`;
    let parts = p.parts.get(id);
    if (!parts) p.parts.set(id, (parts = []));
    parts[m.part] = m.data;
    if (parts.filter((x) => x != null).length < m.parts) return;
    p.parts.delete(id);
    if (p.parts.size > 20) p.parts.clear();
    const bins = parts.map((x) => atob(x));
    const bytes = new Uint8Array(bins.reduce((a, b) => a + b.length, 0));
    let at = 0;
    for (const b of bins) for (let i = 0; i < b.length; i++) bytes[at++] = b.charCodeAt(i);
    if (m.kind === 'init') return open(p, m.mime, bytes);
    if (!p.ms) return;
    p.queue.push(bytes);
    if (p.queue.length > 90) p.queue.splice(0, p.queue.length - 90);
    pump(p);
  }

  /** Stay at the live edge, and step over any gap a slow connection left. */
  function keepLive(p) {
    const v = p.video;
    const b = v.buffered;
    if (!b.length) return;
    const end = b.end(b.length - 1);
    const inRange = [...Array(b.length).keys()].some((i) => v.currentTime >= b.start(i) && v.currentTime <= b.end(i));
    if (!inRange || end - v.currentTime > 1.2) v.currentTime = Math.max(b.start(b.length - 1), end - 0.15);
    if (v.paused) v.play().catch(() => {});
  }

  function ask(force) {
    const key = wanted.join(',');
    if (!force && key === asked && Date.now() - askedAt < ASK_MS) return;
    if (!wanted.length && !asked) return;
    asked = key;
    askedAt = Date.now();
    rcs.send({ type: 'video', cams: wanted });
  }

  setInterval(() => {
    for (const p of players.values()) keepLive(p);
    ask(false);
  }, 250);

  return {
    onMessage,
    /** The cameras on the page now; players for any others go. */
    want(cams) {
      wanted = [...new Set(cams)].sort();
      for (const p of [...players.values()]) if (!wanted.includes(p.cam)) closePlayer(p);
      ask(false);
    },
    /** The camera's <video>, to put in its tile (once; it stays there). */
    element(cam) {
      return player(cam).video;
    },
    /** Is a picture showing for this camera? */
    playing(cam) {
      const p = players.get(cam);
      return !!p && p.video.readyState >= 2 && p.video.videoWidth > 0;
    },
    unsupported(cam) {
      return !!players.get(cam)?.unsupported;
    }
  };
};
