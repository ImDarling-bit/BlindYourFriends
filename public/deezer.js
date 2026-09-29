// Accès à l'API publique Deezer depuis le navigateur.
// L'API ne permet pas les appels fetch cross-origin, mais elle répond en JSONP.
(function () {
  'use strict';

  const API = 'https://api.deezer.com';
  const TRACK_CACHE_MAX = 2000;
  const trackCache = new Map(); // id -> track (sert à l'hôte pour résoudre les picks)
  let seq = 0;

  function jsonp(url, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const cb = `__byfDeezer${++seq}`;
      const script = document.createElement('script');
      const timer = setTimeout(() => done(new Error('Deezer ne répond pas.')), timeoutMs);

      function done(err, data) {
        clearTimeout(timer);
        window[cb] = () => {}; // une réponse tardive ne doit pas planter
        script.remove();
        if (err) reject(err);
        else resolve(data);
      }

      window[cb] = (data) => done(null, data);
      script.onerror = () => done(new Error('Deezer injoignable.'));
      script.src = `${url}${url.includes('?') ? '&' : '?'}output=jsonp&callback=${cb}`;
      document.head.appendChild(script);
    });
  }

  function remember(track) {
    trackCache.delete(track.id);
    trackCache.set(track.id, track);
    if (trackCache.size > TRACK_CACHE_MAX) trackCache.delete(trackCache.keys().next().value);
  }

  function toTrack(t) {
    if (!t || !t.id || typeof t.preview !== 'string' || !t.preview.startsWith('https://')) return null;
    const album = t.album || {};
    return {
      id: String(t.id),
      title: String(t.title_short || t.title || 'Sans titre'),
      artist: String((t.artist && t.artist.name) || 'Artiste inconnu'),
      album: String(album.title || ''),
      cover: String(album.cover_medium || album.cover || ''),
      coverBig: String(album.cover_big || album.cover_medium || album.cover || ''),
      preview: t.preview,
    };
  }

  function check(data) {
    if (data && data.error) throw new Error(data.error.message || 'Erreur Deezer');
    return data;
  }

  // Recherche : seuls les titres avec un extrait sont gardés.
  async function search(query) {
    const q = String(query || '').trim().slice(0, 100);
    if (!q) return [];
    const data = check(await jsonp(`${API}/search?q=${encodeURIComponent(q)}&limit=10`));
    const results = (Array.isArray(data.data) ? data.data : []).map(toTrack).filter(Boolean);
    results.forEach(remember);
    return results;
  }

  // Résolution d'un id par l'hôte : jamais d'URL fournie par un joueur.
  async function resolveTrack(id) {
    const key = String(id);
    if (!/^\d{1,20}$/.test(key)) return null;
    if (trackCache.has(key)) return trackCache.get(key);
    const track = toTrack(check(await jsonp(`${API}/track/${key}`)));
    if (track) remember(track);
    return track;
  }

  window.BYFDeezer = { search, resolveTrack };
})();
