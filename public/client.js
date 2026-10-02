(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const Catalog = window.BYFCatalog;

  const NAME_KEY = 'blindyourfriends.name';
  const VOLUME_KEY = 'blindyourfriends.volume';
  const CIRC = 2 * Math.PI * 19;
  const SCREENS = ['home', 'lobby', 'pick', 'guess', 'reveal', 'end'];
  const SCREEN_FOR = { deliberate: 'guess' };
  const COLORS = ['#ff3d8b', '#8a3ffc', '#c238e6', '#ff7a45', '#20c3a6', '#3d8bff', '#e6b422', '#ff5c7a', '#7a5cff', '#2bb673', '#ff4dd2', '#5ab0ff'];
  const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
  const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>';
  const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/></svg>';
  const ICON_CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';

  let S = null; // dernier état reçu du serveur
  // Réglages de l'hôte ; ceux de la partie en cours remplacent ces valeurs par défaut.
  let config = Object.assign({}, BYFGame.DEFAULTS, (window.BYF_CONFIG || {}).times);
  let net = null; // connexion à la partie : { code, socket, isHost, close }
  let lanUrl = null; // adresse réseau local fournie par le lanceur
  // Jeton propre à cet onglet : permet de reprendre sa place après une coupure.
  const token = Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) => n.toString(36)).join('');
  let clockOffset = 0; // heure serveur - heure locale
  let currentScreen = null;

  // ---------------------------------------------------------------- utilitaires

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function safeUrl(url) {
    const u = String(url || '');
    return /^https:\/\//.test(u) ? esc(u) : '';
  }

  function colorFor(name) {
    let h = 0;
    for (const ch of String(name).toLowerCase()) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return COLORS[h % COLORS.length];
  }

  function initialAvatar(name) {
    const first = Array.from(String(name))[0] || '?';
    return `<span class="avatar" style="background:${colorFor(name)}">${esc(first.toUpperCase())}</span>`;
  }

  const imageAvatar = (src) => `<span class="avatar avatar-img"><img src="${esc(src)}" alt="" decoding="async"></span>`;

  // Images d'avatar reçues ("id:version" -> data URL) : l'hôte ne les envoie qu'une fois.
  const avatarCache = new Map();

  function avatarSrc(id) {
    const p = S && S.players.find((x) => x.id === id);
    const a = p && p.avatar;
    if (!a) return null;
    if (a.kind === 'preset') return Catalog.avatarUrl(a.style, a.seed);
    return avatarCache.get(`${id}:${a.rev}`) || null;
  }

  // Avatar d'un joueur de la partie : sa photo s'il en a choisi une, sinon son initiale.
  function avatar(name, id) {
    const src = id ? avatarSrc(id) : null;
    return src ? imageAvatar(src) : initialAvatar(name);
  }

  function plural(n, word) {
    return `${n} ${word}${n > 1 ? 's' : ''}`;
  }

  function store(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (_) { /* stockage indisponible */ }
  }

  function load(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }

  let toastTimer;
  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function isHost() {
    return S && S.hostId === S.you;
  }

  function songsPerPlayer() {
    return S ? S.settings.songsPerPlayer : null;
  }

  function inviteUrl(code) {
    const base = (window.BYF_CONFIG || {}).publicUrl || lanUrl || `${location.origin}${location.pathname}`;
    return `${base}${base.includes('?') ? '&' : '?'}code=${encodeURIComponent(code)}`;
  }

  function send(event, payload, ack) {
    if (!net) return ack && ack({ error: 'Pas de partie.' });
    net.socket.emit(event, payload, ack);
  }

  const toastError = (res) => res && res.error && toast(res.error);

  // ---------------------------------------------------------------- effets

  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const vibrate = (pattern) => { try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (_) { /* non pris en charge */ } };

  // N'écrit le HTML que s'il a changé : évite de rejouer les animations à chaque état reçu.
  function setHtml(el, html) {
    if (el.dataset.html === html) return;
    el.innerHTML = html;
    el.dataset.html = html;
  }

  // Confettis dessinés sur un canvas plein écran.
  const confetti = (() => {
    const canvas = $('confetti');
    const ctx = canvas.getContext('2d');
    const COLORS = ['#ff3d8b', '#c238e6', '#8a3ffc', '#ffc43d', '#3ee0a1', '#ffffff'];
    let parts = [];
    let raf = null;

    // Taille du canevas alignée sur la fenêtre et sa densité de pixels, qui peuvent changer
    // en cours de route (fenêtre redimensionnée ou déplacée sur un autre écran).
    function fit() {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(innerWidth * dpr);
      const h = Math.round(innerHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function clear() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    function frame() {
      clear();
      fit();
      parts = parts.filter((p) => p.life-- > 0 && p.y < innerHeight + 30);
      for (const p of parts) {
        p.vy += 0.3;
        p.vx *= 0.99;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.scale(1, Math.cos(p.rot * 2)); // effet de papier qui tourne
        ctx.fillStyle = p.color;
        if (p.round) {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        }
        ctx.restore();
      }
      raf = parts.length ? requestAnimationFrame(frame) : null;
      if (!raf) clear();
    }

    function burst({ x = innerWidth / 2, y = innerHeight / 3, count = 100, spread = 1 } = {}) {
      if (reducedMotion()) return;
      for (let i = 0; i < count; i++) {
        parts.push({
          x,
          y,
          vx: (Math.random() - 0.5) * 13 * spread,
          vy: -Math.random() * 11 - 4,
          rot: Math.random() * Math.PI,
          vr: (Math.random() - 0.5) * 0.35,
          size: 6 + Math.random() * 6,
          color: COLORS[Math.floor(Math.random() * COLORS.length)],
          round: Math.random() < 0.3,
          life: 150 + Math.random() * 70,
        });
      }
      if (!raf) raf = requestAnimationFrame(frame);
    }

    return { burst };
  })();

  // Confettis qui partent d'un élément de la page.
  function celebrate(el, count, spread) {
    const r = el.getBoundingClientRect();
    confetti.burst({ x: r.left + r.width / 2, y: r.top + Math.min(r.height, 60), count, spread });
  }

  // Annonce plein écran, brève et non bloquante.
  let splashTimer = null;
  function splash(text, kicker) {
    if (reducedMotion()) return;
    const el = $('splash');
    $('splashText').textContent = text;
    $('splashKicker').textContent = kicker || '';
    el.classList.remove('show');
    void el.offsetWidth; // relance l'animation
    el.classList.add('show');
    clearTimeout(splashTimer);
    splashTimer = setTimeout(() => el.classList.remove('show'), 1500);
  }

  // Annonce les moments clés : nouvelle manche, nouveau son, délibération.
  let lastMoment = null;
  function announce() {
    const mode = Catalog.mode(S.mode);
    let key = null;
    let text = '';
    let kicker = '';
    if (S.phase === 'pick') {
      key = `pick:${S.round}`;
      text = `Manche ${S.round}`;
      kicker = mode.label;
    } else if (S.phase === 'guess' && S.sound) {
      key = `guess:${S.round}:${S.sound.index}`;
      if (S.sound.index === 1 && Catalog.isQuiz(S.mode)) {
        text = `Manche ${S.round}`;
        kicker = `${mode.label} · ${plural(S.sound.total, 'son')}`;
      } else {
        text = `Son ${S.sound.index}`;
        kicker = S.sound.index === 1 ? "C'est parti" : `sur ${S.sound.total}`;
      }
    } else if (S.phase === 'deliberate') {
      key = `deliberate:${S.round}:${S.sound.index}`;
      text = 'Prolongation';
      kicker = 'Encore un peu de temps';
    }
    if (!key) {
      if (lastMoment === null) lastMoment = 'calme';
      return;
    }
    if (key === lastMoment) return;
    const joinedMidGame = lastMoment === null;
    lastMoment = key;
    if (!joinedMidGame) splash(text, kicker);
  }

  // Mon score dans la barre du haut, qui rebondit quand il monte.
  let myScoreShown = null;
  function renderMyScore() {
    const me = S.players.find((p) => p.id === S.you);
    const show = !!me && S.phase !== 'lobby';
    $('myScore').classList.toggle('hidden', !show);
    if (!show) return;
    const el = $('myScore');
    if (myScoreShown !== null && me.score > myScoreShown) {
      el.classList.remove('bump');
      void el.offsetWidth;
      el.classList.add('bump');
    }
    $('myScoreValue').textContent = me.score;
    myScoreShown = me.score;
  }

  // ---------------------------------------------------------------- audio

  const gameAudio = new Audio();
  gameAudio.preload = 'auto';
  gameAudio.loop = true; // l'extrait repart pendant la délibération
  const previewAudio = new Audio();
  previewAudio.preload = 'none';

  let gameKey = null; // "manche:index:étape" du son en cours
  let clipTimer = null; // blind test progressif : coupe l'extrait à la fin de l'étape
  let clipLength = 0; // durée de l'extrait de l'étape en cours (0 : pas de coupure)
  let previewId = null;
  let audioUnlocked = false;

  // iOS & co : un play() déclenché par un geste "débloque" l'élément audio pour la suite.
  function unlockAudio() {
    if (audioUnlocked || gameKey) return;
    audioUnlocked = true;
    gameAudio.src = SILENT_WAV;
    gameAudio.play().then(() => { if (!gameKey) gameAudio.pause(); }).catch(() => {});
  }
  document.addEventListener('pointerdown', unlockAudio, { once: true });

  function playGame() {
    gameAudio.play()
      .then(() => $('unlockBtn').classList.add('hidden'))
      .catch(() => { if (gameKey) $('unlockBtn').classList.remove('hidden'); });
  }

  function stopGame() {
    gameKey = null;
    clipLength = 0;
    clearTimeout(clipTimer);
    gameAudio.pause();
    $('unlockBtn').classList.add('hidden');
  }

  // Égaliseur décoratif : des barres aux rythmes décalés, actives pendant la lecture.
  $('eq').innerHTML = Array.from({ length: 18 }, (_, i) =>
    `<span style="--d:${-((i * 137) % 900)}ms;--s:${(0.55 + ((i * 53) % 50) / 100).toFixed(2)}s"></span>`).join('');
  const setPlaying = (on) => {
    $('guessVinyl').classList.toggle('playing', on);
    $('eq').classList.toggle('playing', on);
  };
  gameAudio.addEventListener('play', () => setPlaying(true));
  gameAudio.addEventListener('pause', () => setPlaying(false));
  // Le chrono de l'extrait part quand le son démarre vraiment (après le chargement).
  gameAudio.addEventListener('playing', () => {
    clearTimeout(clipTimer);
    if (clipLength) clipTimer = setTimeout(() => gameAudio.pause(), clipLength * 1000);
  });

  $('unlockBtn').addEventListener('click', () => {
    audioUnlocked = true;
    playGame();
  });

  function syncGameAudio() {
    const playing = S && ['guess', 'deliberate', 'reveal'].includes(S.phase);
    const sound = playing ? S.sound : null;
    if (!sound || !sound.track) return stopGame();
    // Blind test progressif : chaque étape rejoue le début de l'extrait, de plus en plus long ;
    // au reveal, on réécoute le son en entier.
    const staged = S.phase === 'guess' && S.stage;
    const step = staged ? S.stage.index : S.mode === 'progressive' && S.phase === 'reveal' ? 'fin' : '';
    const key = `${S.round}:${sound.index}:${step}`;
    if (key === gameKey) return;
    const sameSound = gameKey && gameKey.startsWith(`${S.round}:${sound.index}:`);
    gameKey = key;
    clearTimeout(clipTimer);
    stopPreview();
    if (!sameSound) gameAudio.src = sound.track.preview;
    gameAudio.loop = !staged;
    clipLength = staged ? S.stage.clip : 0;
    gameAudio.currentTime = 0;
    playGame();
  }

  function stopPreview() {
    previewAudio.pause();
    previewId = null;
    renderResults();
  }

  function togglePreview(id) {
    const track = results.find((t) => t.id === id);
    if (!track) return;
    if (previewId === id && !previewAudio.paused) return stopPreview();
    previewId = id;
    previewAudio.src = track.preview;
    previewAudio.play().catch(() => { previewId = null; renderResults(); toast('Lecture impossible.'); });
    renderResults();
  }
  previewAudio.addEventListener('ended', () => { previewId = null; renderResults(); });

  // ---------------------------------------------------------------- volume

  function setVolume(percent, save) {
    const v = Math.max(0, Math.min(100, Math.round(Number(percent))));
    gameAudio.volume = v / 100;
    previewAudio.volume = v / 100;
    $('volumeRange').value = String(v);
    $('volumeRange').style.setProperty('--fill', `${v}%`);
    $('volumeValue').textContent = `${v} %`;
    $('volumeBtn').parentElement.classList.toggle('muted-vol', v === 0);
    if (save) store(VOLUME_KEY, String(v));
  }

  const savedVolume = Number(load(VOLUME_KEY));
  setVolume(load(VOLUME_KEY) != null && Number.isFinite(savedVolume) ? savedVolume : 80, false);

  $('volumeRange').addEventListener('input', () => setVolume($('volumeRange').value, true));
  $('volumeBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const open = $('volumePop').classList.toggle('hidden') === false;
    $('volumeBtn').setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (e) => {
    if (!$('volumePop').classList.contains('hidden') && !e.target.closest('.volume')) {
      $('volumePop').classList.add('hidden');
      $('volumeBtn').setAttribute('aria-expanded', 'false');
    }
  });

  // ---------------------------------------------------------------- règles

  function renderRules() {
    const c = config;
    const mode = (S && S.settings.mode) || Catalog.DEFAULT_MODE;
    const n = songsPerPlayer();
    const songs = n
      ? `<strong>${plural(n, 'son')}</strong> (réglé par l'hôte)`
      : `entre <strong>${c.songsMin} et ${c.songsMax} sons</strong>, selon le réglage de l'hôte`;
    const items = [
      `Un joueur crée la partie et partage le code à 4 lettres. De <strong>${c.minPlayers} à ${c.maxPlayers} joueurs</strong>. L'hôte choisit le mode de jeu : <strong>${esc(Catalog.mode(mode).label)}</strong> pour l'instant.`,
    ];
    if (Catalog.isQuiz(mode)) {
      const source = S ? Catalog.source(S.settings.source) : null;
      items.push(`Le jeu choisit <strong>${S ? plural(S.settings.songCount, 'son') : 'les sons'}</strong>${source ? ` dans le style <strong>${esc(source.label)}</strong>` : ''}. Tout le monde écoute le même extrait.`);
      items.push('Tape le <strong>titre</strong> ou l\'<strong>artiste</strong> et valide. Les accents, majuscules et petites fautes de frappe sont tolérés ; tu peux aussi taper les deux d\'un coup. Tu peux réessayer autant que tu veux.');
      if (mode === 'progressive') {
        const steps = c.progressiveClips.map((clip, i) => `${clip} s : ${c.progressivePoints[i]}`).join(', ');
        items.push(`L'extrait s'allonge à chaque étape, avec ${c.stageGap} s pour répondre après chacune. Plus tu trouves tôt, plus ça rapporte : ${steps} points (moitié pour le titre, moitié pour l'artiste).`);
      } else {
        items.push(`Chaque son dure <strong>${c.guessTime} s</strong>. +${c.quizTitlePoints} pour le titre, +${c.quizArtistPoints} pour l'artiste, et +${c.quizFirstBonus} au premier qui trouve chacun des deux.`);
      }
      items.push('Dès que tout le monde a tout trouvé, on passe au son suivant.');
    } else {
      if (mode === 'byf-theme') {
        items.push(`Un <strong>thème</strong> est imposé (choisi par l'hôte ou au hasard) : tes sons doivent coller au thème.`);
      }
      items.push(`<strong>Préparation</strong> : chacun choisit en secret ${songs}, avec ${c.pickTime} s par son. Les autres voient ton avancement, jamais tes choix.`);
      items.push(`<strong>Écoute</strong> : tous les sons passent un par un, dans le désordre, <strong>${c.guessTime} s</strong> chacun. Vote pour la personne qui l'a mis : <strong>ton premier choix est définitif</strong>. Si c'est ton son, tu ne votes pas : fais genre.`);
      if (mode === 'byf-theme') {
        items.push(`Si un son ne colle pas au thème, appuie sur <strong>Hors thème</strong>. Si la majorité des autres joueurs le signale, son propriétaire perd ${c.offThemePenalty} points.`);
      }
      items.push(`<strong>Prolongation</strong> : si certains n'ont pas encore voté et que les votes déjà donnés ne désignent pas tous la même personne, ils ont <strong>${c.deliberateTime} s de plus</strong> pour se décider. Personne ne voit les votes des autres avant le reveal.`);
      items.push(`<strong>Points</strong> : +${c.pointsGoodGuess} par bonne réponse. Le propriétaire du son gagne +${c.pointsPerFooled} par joueur qui s'est trompé.`);
    }
    items.push("À la fin de la manche, le podium révèle le gagnant et la lanterne rouge. L'hôte peut relancer une manche, dans le même mode ou un autre : chaque manche repart de zéro.");
    $('rulesList').innerHTML = items.map((i) => `<li>${i}</li>`).join('');
    $('rulesModes').innerHTML = Catalog.MODES.map((m) => `<li><strong>${esc(m.label)}</strong> : ${esc(m.short)}</li>`).join('');
  }

  function openRules() {
    renderRules();
    $('rulesModal').classList.remove('hidden');
    $('rulesClose').focus();
  }

  function closeRules() {
    $('rulesModal').classList.add('hidden');
    $('rulesBtn').focus();
  }

  $('rulesBtn').addEventListener('click', openRules);
  $('rulesClose').addEventListener('click', closeRules);
  $('rulesModal').addEventListener('click', (e) => { if (e.target === $('rulesModal')) closeRules(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('rulesModal').classList.contains('hidden')) closeRules();
  });

  // Le lanceur (ou `npm start`) indique l'adresse du PC sur le Wi-Fi, pour inviter sans hébergement.
  fetch('api/lan').then((r) => (r.ok ? r.json() : null)).then((d) => { lanUrl = (d && d.url) || null; }).catch(() => {});

  // ---------------------------------------------------------------- écrans

  function showScreen(name) {
    if (name === currentScreen) return;
    const prev = currentScreen;
    currentScreen = name;
    for (const s of SCREENS) $(`screen-${s}`).classList.toggle('hidden', s !== name);
    $('topbar').classList.toggle('hidden', name === 'home');
    if (prev === 'pick') stopPreview();
    if (name === 'pick') resetSearch();
    window.scrollTo(0, 0);
  }

  function render() {
    if (!S) return showScreen('home');
    showScreen(SCREEN_FOR[S.phase] || S.phase);
    $('tbCode').textContent = S.code;
    $('tbRound').textContent = S.round ? `Manche ${S.round}` : '';
    $('timer').classList.toggle('hidden', !S.endsAt);

    if (S.phase === 'lobby') renderLobby();
    else if (S.phase === 'pick') renderPick();
    else if (S.phase === 'guess' || S.phase === 'deliberate') renderGuess();
    else if (S.phase === 'reveal') renderReveal();
    else if (S.phase === 'end') renderEnd();

    // Thème imposé, affiché pendant la préparation et l'écoute.
    document.querySelectorAll('[data-theme-banner]').forEach((el) => {
      el.classList.toggle('hidden', !S.theme);
      el.innerHTML = S.theme ? `<span>Thème</span><strong>${esc(S.theme)}</strong>` : '';
    });
    if (!$('rulesModal').classList.contains('hidden')) renderRules();
    renderMyScore();
    announce();
    document.querySelectorAll('[data-action="leave"]').forEach((b) => {
      b.textContent = net && net.isHost ? 'Fermer la partie (pour tout le monde)' : 'Quitter la partie';
    });
    syncGameAudio();
  }

  function playerRow(p) {
    const tags = [];
    if (p.id === S.hostId) tags.push('<span class="tag tag-host">Hôte</span>');
    if (p.id === S.you) tags.push('<span class="tag">Toi</span>');
    return `<li>${avatar(p.name, p.id)}<span class="player-name">${esc(p.name)}</span>${tags.join('')}</li>`;
  }

  function stepper(field, value, min, max, label) {
    if (!isHost()) return `<div class="stepper"><output>${value}</output></div>`;
    return `<div class="stepper">
        <button class="icon-btn icon-btn-small" data-field="${field}" data-value="${value - 1}" aria-label="${label} : moins" ${value <= min ? 'disabled' : ''}>-</button>
        <output aria-live="polite">${value}</output>
        <button class="icon-btn icon-btn-small" data-field="${field}" data-value="${value + 1}" aria-label="${label} : plus" ${value >= max ? 'disabled' : ''}>+</button>
      </div>`;
  }

  function select(field, value, options, label) {
    if (!isHost()) {
      const current = options.find((o) => o.id === value);
      return `<strong class="setting-value">${esc(current ? current.label : '')}</strong>`;
    }
    return `<select class="input select" data-select="${field}" aria-label="${label}">
        ${options.map((o) => `<option value="${esc(o.id)}"${o.id === value ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>`;
  }

  function settingRow(title, hint, control) {
    return `<div class="settings-row">
        <div><h2>${title}</h2>${hint ? `<p class="muted">${hint}</p>` : ''}</div>
        ${control}
      </div>`;
  }

  // Réglages de la partie (mode de jeu et options du mode) : modifiables par l'hôte,
  // en lecture seule pour les autres.
  function settingsHtml() {
    const st = S.settings;
    const c = S.config;
    const host = isHost();
    const modes = host ? Catalog.MODES : [Catalog.mode(st.mode)];
    let html = `<h2>Mode de jeu</h2>
      <div class="modes">
        ${modes.map((m) => `<button class="mode-card${m.id === st.mode ? ' selected' : ''}" data-mode="${m.id}" ${host ? '' : 'disabled'}>
            <strong>${esc(m.label)}</strong><span>${esc(m.short)}</span>
          </button>`).join('')}
      </div>`;

    if (Catalog.isQuiz(st.mode)) {
      html += settingRow('Style de musique', host ? '' : "Choisi par l'hôte", select('source', st.source, Catalog.SOURCES, 'Style de musique'));
      html += settingRow('Nombre de sons', '', stepper('songCount', st.songCount, c.songCountMin, c.songCountMax, 'Nombre de sons'));
    } else {
      if (st.mode === 'byf-theme') {
        const themes = [{ id: 'random', label: 'Au hasard' }].concat(Catalog.THEMES, [{ id: 'custom', label: 'Thème libre...' }]);
        let control = select('theme', st.theme, themes, 'Thème');
        if (!host && st.theme === 'custom') control = `<strong class="setting-value">${esc(st.customTheme || 'Thème libre')}</strong>`;
        html += settingRow('Thème', st.theme === 'random' ? 'Tiré au sort au lancement' : '', control);
        if (host && st.theme === 'custom') {
          html += `<input class="input" data-custom-theme maxlength="40" placeholder="Ex. : chanson de mariage" value="${esc(st.customTheme)}" aria-label="Thème libre">`;
        }
      }
      html += settingRow('Sons par joueur', `${st.songsPerPlayer * c.pickTime} s pour les choisir`,
        stepper('songsPerPlayer', st.songsPerPlayer, c.songsMin, c.songsMax, 'Sons par joueur'));
    }
    return html;
  }

  function renderSettings() {
    const html = settingsHtml();
    document.querySelectorAll('[data-settings]').forEach((el) => {
      // Ne pas reconstruire pendant que l'hôte écrit ou choisit dans une liste.
      if (el.contains(document.activeElement) && document.activeElement.matches('input, select')) return;
      if (el.dataset.html !== html) {
        el.innerHTML = html;
        el.dataset.html = html;
      }
    });
  }

  const sendSetting = (patch) => send('settings', patch, toastError);

  document.querySelectorAll('[data-settings]').forEach((el) => {
    el.addEventListener('click', (e) => {
      const mode = e.target.closest('[data-mode]');
      if (mode && !mode.disabled) return sendSetting({ mode: mode.dataset.mode });
      const btn = e.target.closest('[data-field]');
      if (btn && !btn.disabled) sendSetting({ [btn.dataset.field]: Number(btn.dataset.value) });
    });
    el.addEventListener('change', (e) => {
      const sel = e.target.closest('[data-select]');
      if (sel) {
        sel.blur();
        return sendSetting({ [sel.dataset.select]: sel.value });
      }
      if (e.target.matches('[data-custom-theme]')) sendSetting({ customTheme: e.target.value });
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('[data-custom-theme]')) e.target.blur();
    });
  });

  function renderLobby() {
    $('lobbyCode').textContent = S.code;
    $('inviteLink').value = inviteUrl(S.code);
    $('lobbyCount').textContent = `${S.players.length}/${S.config.maxPlayers}`;
    $('lobbyPlayers').innerHTML = S.players.map(playerRow).join('');
    renderSettings();

    const enough = S.players.length >= S.config.minPlayers;
    $('startBtn').classList.toggle('hidden', !isHost());
    $('startBtn').disabled = !enough;
    $('startBtn').classList.toggle('ready', isHost() && enough);
    $('lobbyHint').textContent = isHost()
      ? (enough ? 'Tout le monde est là ? Lance quand tu veux.' : `Il faut au moins ${S.config.minPlayers} joueurs. Partage le code.`)
      : `Mode : ${Catalog.mode(S.settings.mode).label}. En attente de l'hôte.`;
  }

  function renderPick() {
    const n = songsPerPlayer();
    const picks = S.myPicks || [];
    $('pickTitle').textContent = n > 1 ? `Choisis tes ${n} sons` : 'Choisis ton son';

    let slots = '';
    for (let i = 0; i < n; i++) {
      const t = picks[i];
      slots += t
        ? `<div class="pick-slot">
            <img src="${safeUrl(t.cover)}" alt="">
            <div class="track-meta"><div class="t">${esc(t.title)}</div><div class="a">${esc(t.artist)}</div></div>
            <button class="icon-btn icon-btn-small" data-unpick="${esc(t.id)}" aria-label="Retirer ce son">${ICON_CLOSE}</button>
          </div>`
        : `<div class="pick-slot empty"><span class="slot-num">${i + 1}</span>Son ${i + 1} à choisir</div>`;
    }
    $('myPicks').innerHTML = slots;

    renderResults();
    $('pickChips').innerHTML = S.players
      .filter((p) => p.active)
      .map((p) => `<span class="chip${p.picked >= n ? ' done' : ''}">${avatar(p.name, p.id)}${esc(p.name)}
        <span class="count">${p.picked}/${n}</span></span>`)
      .join('');
  }

  function renderGuess() {
    const { track, index, total } = S.sound;
    const quiz = Catalog.isQuiz(S.mode);
    const deliberating = S.phase === 'deliberate';
    $('guessCounter').textContent = `Son ${index} / ${total}${deliberating ? ' · prolongation' : ''}`;

    // En blind test, ni pochette ni titre avant le reveal.
    const cover = $('guessCover');
    const coverUrl = !quiz && /^https:\/\//.test(track.coverBig) ? track.coverBig : '';
    if (cover.getAttribute('src') !== coverUrl) cover.setAttribute('src', coverUrl);
    cover.classList.toggle('hidden', quiz);
    $('guessMystery').classList.toggle('hidden', !quiz);
    $('guessVinyl').classList.toggle('mystery', quiz);
    $('guessTitle').textContent = quiz ? 'Quel est ce son ?' : track.title;
    $('guessArtist').textContent = quiz ? '' : track.artist;

    // Prolongation : aucune information sur les votes des autres avant le reveal.
    $('deliberateBanner').classList.toggle('hidden', !deliberating);

    renderStages();
    if (quiz) return renderAnswer();
    $('answerForm').classList.add('hidden');

    let body;
    if (S.isMine) {
      body = '<div class="notice"><strong>C\'est ton son.</strong><span>Fais genre.</span></div>';
    } else if (!S.canVote) {
      body = '<div class="notice"><strong>Tu joues à la prochaine manche.</strong><span>Profite du son.</span></div>';
    } else {
      // Le premier vote est définitif : une fois voté, les boutons sont verrouillés.
      const locked = !!S.myVote;
      body = `<p class="eyebrow center">${locked ? 'Vote verrouillé' : 'Qui a mis ça ? Ton premier choix est définitif.'}</p><div class="vote-grid">` +
        S.candidates.map((c) => `
          <button class="vote-btn${S.myVote === c.id ? ' selected' : ''}" data-vote="${esc(c.id)}" ${locked ? 'disabled' : ''}>
            ${avatar(c.name, c.id)}<span>${esc(c.name)}</span>
          </button>`).join('') + '</div>';
      if (S.mode === 'byf-theme') {
        body += `<button class="btn btn-ghost offtheme-btn${S.myOffTheme ? ' active' : ''}" data-offtheme="${S.myOffTheme ? '0' : '1'}" aria-pressed="${S.myOffTheme}">
            ${S.myOffTheme ? 'Signalé hors thème (annuler)' : 'Hors thème ?'}
          </button>`;
      }
    }
    setHtml($('guessBody'), body);
  }

  // Blind test progressif : les étapes de l'extrait (1 s, 2 s, 4 s...).
  function renderStages() {
    const st = S.phase === 'guess' ? S.stage : null;
    $('stages').classList.toggle('hidden', !st);
    if (!st) return;
    $('stageList').innerHTML = S.config.progressiveClips.map((clip, i) => {
      const cls = i < st.index ? 'past' : i === st.index ? 'current' : '';
      return `<li class="${cls}">${clip} s</li>`;
    }).join('');
    $('stageInfo').textContent = `Extrait de ${st.clip} s · vaut ${st.points} points (moitié titre, moitié artiste)`;
  }

  let answerKey = null; // son pour lequel le champ de réponse a été préparé

  // Blind test : champ de réponse, ce que j'ai trouvé, et l'avancement des autres.
  function renderAnswer() {
    const key = `${S.round}:${S.sound.index}`;
    const found = S.found || { title: null, artist: null };
    const done = found.title !== null && found.artist !== null;
    const form = $('answerForm');
    form.classList.toggle('hidden', !S.canAnswer);
    if (answerKey !== key) {
      answerKey = key;
      $('answerInput').value = '';
      setFeedback('', '');
      if (S.canAnswer && window.matchMedia('(pointer: fine)').matches) $('answerInput').focus();
    }
    const tag = (el, pts, label) => {
      el.classList.toggle('on', pts !== null);
      el.textContent = pts !== null ? `${label} +${pts}` : label;
    };
    tag($('foundTitle'), found.title, 'Titre');
    tag($('foundArtist'), found.artist, 'Artiste');
    $('answerInput').disabled = done;
    $('answerBtn').disabled = done;
    $('answerInput').placeholder = done ? 'Tout trouvé, attends les autres' : 'Titre ou artiste...';

    const notice = S.canAnswer ? '' : '<div class="notice"><strong>Tu joues à la prochaine manche.</strong><span>Profite du son.</span></div>';
    setHtml($('guessBody'), `${notice}<div class="chips quiz-progress">` + (S.progress || []).map((p) => `
        <span class="chip${p.title && p.artist ? ' done' : ''}">${avatar(p.name, p.id)}${esc(p.name)}
          <span class="mini${p.title ? ' on' : ''}" title="Titre">T</span><span class="mini${p.artist ? ' on' : ''}" title="Artiste">A</span>
        </span>`).join('') + '</div>');
  }

  function setFeedback(text, kind) {
    const el = $('answerFeedback');
    el.textContent = text;
    el.className = `answer-feedback${kind ? ` ${kind}` : ''}`;
  }

  $('answerForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('answerInput');
    const text = input.value.trim();
    if (!text || input.disabled) return;
    send('answer', { text }, (res) => {
      if (!res || res.error) return setFeedback((res && res.error) || 'Réponse non envoyée.', 'bad');
      if (res.found) {
        const parts = [];
        if (res.gained.title) parts.push(`Titre trouvé ! +${res.gained.title}`);
        if (res.gained.artist) parts.push(`Artiste trouvé ! +${res.gained.artist}`);
        setFeedback(parts.join(' · '), 'good');
        input.value = '';
        celebrate(input, 45, 0.8);
        vibrate(40);
        $('answerForm').classList.add('success');
        setTimeout(() => $('answerForm').classList.remove('success'), 800);
      } else {
        setFeedback(res.title || res.artist ? 'Déjà trouvé, cherche l\'autre partie.' : 'Pas ça...', 'bad');
        vibrate([20, 40, 20]);
        input.select();
        $('answerForm').classList.remove('shake');
        void $('answerForm').offsetWidth; // relance l'animation
        $('answerForm').classList.add('shake');
      }
    });
  });

  function rankingHtml(gains) {
    return [...S.players]
      .sort((a, b) => b.score - a.score)
      .map((p, i) => {
        const g = gains && gains[p.id];
        const gain = g ? `<span class="gain${g < 0 ? ' loss' : ''}">${g > 0 ? '+' : ''}${g}</span>` : '';
        return `<li class="${p.id === S.you ? 'me' : ''}" data-id="${esc(p.id)}"><span class="rank">${i + 1}</span>${avatar(p.name, p.id)}
          <span class="player-name">${esc(p.name)}</span>${gain}<span class="score">${p.score}</span></li>`;
      })
      .join('');
  }

  function countUp(el, from, to, delay) {
    el.textContent = from;
    setTimeout(() => {
      const t0 = performance.now();
      const step = (now) => {
        const k = Math.min(1, (now - t0) / 700);
        el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3)));
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }, delay);
  }

  // Classement du reveal : les lignes partent de l'ancien ordre, puis glissent vers le nouveau
  // pendant que les scores défilent.
  let rankingKey = null;
  function renderRanking(el, gains, key) {
    el.innerHTML = rankingHtml(gains);
    if (key === rankingKey || reducedMotion()) return;
    rankingKey = key;
    const before = (p) => p.score - ((gains && gains[p.id]) || 0);
    const newOrder = [...S.players].sort((a, b) => b.score - a.score).map((p) => p.id);
    const oldOrder = [...S.players].sort((a, b) => before(b) - before(a)).map((p) => p.id);
    const rows = [...el.children];
    const stepPx = rows.length > 1 ? rows[1].offsetTop - rows[0].offsetTop : 0;
    for (const li of rows) {
      const p = S.players.find((x) => x.id === li.dataset.id);
      if (!p) continue;
      if (before(p) !== p.score) countUp(li.querySelector('.score'), before(p), p.score, 1200);
      const shift = (oldOrder.indexOf(p.id) - newOrder.indexOf(p.id)) * stepPx;
      if (shift) {
        li.animate(
          [{ transform: `translateY(${shift}px)` }, { transform: `translateY(${shift}px)`, offset: 0.55 }, { transform: 'none' }],
          { duration: 2000, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
        );
        if (shift > 0) li.classList.add('climbed');
      }
    }
  }

  // La carte "C'était..." se retourne, puis confettis si j'ai marqué.
  let revealKey = null;
  let flipTimer = null;
  function flipReveal(r) {
    const key = `${S.round}:${S.sound.index}`;
    if (key === revealKey) return;
    revealKey = key;
    const card = $('revealFlip');
    clearTimeout(flipTimer);
    card.classList.remove('flipped');
    const gained = (r.gains[S.you] || 0) > 0;
    if (reducedMotion()) return card.classList.add('flipped');
    void card.offsetWidth;
    flipTimer = setTimeout(() => {
      card.classList.add('flipped');
      if (gained) {
        celebrate(card, 60, 1);
        vibrate(30);
      }
    }, 650);
  }

  function renderReveal() {
    const r = S.reveal;
    $('revealCounter').textContent = `Son ${S.sound.index} / ${S.sound.total}`;
    $('revealCover').setAttribute('src', /^https:\/\//.test(r.track.cover) ? r.track.cover : '');
    $('revealTitle').textContent = r.track.title;
    $('revealArtist').textContent = r.track.artist;
    renderRanking($('revealRanking'), r.gains, `${S.round}:${S.sound.index}`);
    flipReveal(r);
    if (r.kind === 'quiz') return renderQuizReveal(r);

    $('revealListTitle').textContent = 'Votes';
    const ownerGain = r.gains[r.ownerId] || 0;
    const fooled = r.votes.filter((v) => !v.correct).length;
    const who = r.ownerId === S.you ? 'Toi' : esc(r.ownerName);
    let detail = '';
    if (fooled) detail = `+${fooled * S.config.pointsPerFooled} pts · ${plural(fooled, 'piégé')}`;
    if (r.offTheme && r.offTheme.penalized) detail += `${detail ? ' · ' : ''}hors thème -${r.offTheme.penalty}`;
    $('revealOwner').innerHTML = `<small>C'était</small><strong>${who}</strong>` + (detail || ownerGain ? `<em>${detail}</em>` : '');

    let list = r.votes.length
      ? r.votes.map((v, i) => `<li style="--i:${i}">${avatar(v.voterName, v.voterId)}<span class="who">${esc(v.voterName)}</span>
          <span class="arrow">a voté</span><span>${esc(v.targetName)}</span>
          ${v.correct ? `<span class="ok">Juste +${S.config.pointsGoodGuess}</span>` : '<span class="ko">Raté</span>'}</li>`).join('')
      : '<li class="muted">Personne n\'a voté.</li>';
    if (r.offTheme && r.offTheme.count) {
      const o = r.offTheme;
      list = `<li class="offtheme-line${o.penalized ? ' penalized' : ''}">Hors thème pour ${o.count} sur ${o.total} :
          ${o.penalized ? `${esc(r.ownerName)} perd ${o.penalty} points` : 'pas de majorité, pas de pénalité'}</li>` + list;
    }
    setHtml($('revealVotes'), list);
  }

  function renderQuizReveal(r) {
    $('revealListTitle').textContent = 'Réponses';
    $('revealOwner').innerHTML = `<small>C'était</small><strong>${esc(r.track.title)}</strong><em>${esc(r.track.artist)}</em>`;
    const part = (pts, label) => (pts !== null ? `<span class="ok">${label} +${pts}</span>` : '');
    setHtml($('revealVotes'), r.results.length
      ? r.results.map((x, i) => `<li style="--i:${i}">${avatar(x.name, x.id)}<span class="who">${esc(x.name)}</span>
          ${x.title === null && x.artist === null ? '<span class="ko">Rien trouvé</span>' : `<span class="parts">${part(x.title, 'Titre')}${part(x.artist, 'Artiste')}</span>`}
        </li>`).join('')
      : '<li class="muted">Personne n\'a joué ce son.</li>');
  }

  const CROWN = '<svg class="crown" viewBox="0 0 40 28" aria-hidden="true"><path d="M3 22 6 5l8.5 8.5L20 2l5.5 11.5L34 5l3 17z" fill="currentColor"/><rect x="3" y="23" width="34" height="5" rx="2" fill="currentColor"/></svg>';

  // Podium de fin de manche (2e, 1er, 3e) et reste du classement, avec la lanterne rouge.
  let endKey = null;
  let endTimers = [];
  function renderEnd() {
    const ranked = [...S.players].sort((a, b) => b.score - a.score);
    const n = ranked.length;
    const rankOf = (p) => ranked.findIndex((x) => x.score === p.score) + 1; // ex aequo : même rang
    const winners = n ? ranked.filter((p) => p.score === ranked[0].score) : [];
    const loser = n >= 2 && ranked[n - 1].score < ranked[0].score ? ranked[n - 1] : null;
    const nameOf = (p) => (p.id === S.you ? 'Toi' : esc(p.name));

    let title = '';
    if (winners.length > 1) title = '<span>Égalité</span> au sommet !';
    else if (winners.length && winners[0].id === S.you) title = '<span>Tu as gagné</span> !';
    else if (winners.length) title = `<span>${esc(winners[0].name)}</span> gagne !`;
    $('endTitle').innerHTML = title;
    $('endRound').textContent = `Manche ${S.round} · ${Catalog.mode(S.mode).label}`;

    const top = ranked.slice(0, 3);
    const order = top.length === 3 ? [1, 0, 2] : top.length === 2 ? [1, 0] : [0];
    setHtml($('podium'), order.map((i) => {
      const p = top[i];
      const place = i + 1;
      const isLoser = loser && loser.id === p.id;
      return `<div class="podium-spot place-${place}${isLoser ? ' is-loser' : ''}">
          <div class="podium-player">${place === 1 ? CROWN : ''}${avatar(p.name, p.id)}
            <span class="podium-name">${nameOf(p)}</span>
            <span class="podium-score">${p.score} pts</span>
            ${isLoser ? '<span class="loser-badge">Lanterne rouge</span>' : ''}
          </div>
          <div class="podium-block"><span>${rankOf(p)}</span></div>
        </div>`;
    }).join(''));
    $('podium').style.setProperty('--cols', String(order.length));

    const rest = ranked.slice(3).map((p, i) => {
      const isLoser = loser && loser.id === p.id;
      return `<li class="${p.id === S.you ? 'me' : ''}${isLoser ? ' is-loser' : ''}" style="--i:${i}">
          <span class="rank">${rankOf(p)}</span>${avatar(p.name, p.id)}<span class="player-name">${esc(p.name)}</span>
          ${isLoser ? '<span class="loser-badge">Lanterne rouge</span>' : ''}<span class="score">${p.score}</span>
        </li>`;
    }).join('');
    setHtml($('endRanking'), rest);
    $('endRanking').classList.toggle('hidden', !rest);

    const key = `${S.code}:${S.round}`;
    if (key !== endKey) {
      endKey = key;
      playEndSequence(winners.some((w) => w.id === S.you));
    }

    renderSettings();
    const enough = S.players.length >= S.config.minPlayers;
    $('restartBtn').classList.toggle('hidden', !isHost());
    $('restartBtn').disabled = !enough;
    $('endHint').textContent = isHost()
      ? (enough ? 'Nouvelle manche : les scores repartent de zéro.' : `Il faut au moins ${S.config.minPlayers} joueurs.`)
      : "L'hôte peut relancer une manche.";
  }

  // Annonce du podium : 3e, 2e, puis le gagnant sous les confettis, puis la lanterne rouge.
  function playEndSequence(iWon) {
    const screen = $('screen-end');
    endTimers.forEach(clearTimeout);
    endTimers = [];
    screen.classList.remove('end-show');
    void screen.offsetWidth;
    screen.classList.add('end-show');
    if (reducedMotion()) return;
    const at = (ms, fn) => endTimers.push(setTimeout(fn, ms));
    at(2750, () => {
      celebrate($('podium').querySelector('.place-1') || $('podium'), 170, 1.5);
      if (iWon) vibrate([60, 40, 120]);
    });
    at(3500, () => celebrate($('podium'), 90, 2));
  }

  $('replayBtn').addEventListener('click', () => playEndSequence(false));

  // ---------------------------------------------------------------- recherche

  let results = [];
  let searchTimer = null;
  let searchSeq = 0;
  let pickPending = null;

  function resetSearch() {
    clearTimeout(searchTimer);
    searchSeq++;
    results = [];
    $('searchInput').value = '';
    $('searchSpinner').classList.add('hidden');
    setSearchHint('Tape quelque chose pour chercher.');
    renderResults();
  }

  function setSearchHint(text) {
    $('searchHint').textContent = text;
    $('searchHint').classList.toggle('hidden', !text);
  }

  function renderResults() {
    const picks = (S && S.myPicks) || [];
    const full = S && picks.length >= songsPerPlayer();
    $('results').innerHTML = results.map((t) => {
      const picked = picks.some((p) => p.id === t.id);
      const playing = t.id === previewId;
      const button = picked
        ? `<button class="btn btn-ghost pick-btn" data-unpick="${esc(t.id)}">Retirer</button>`
        : `<button class="btn btn-primary pick-btn" data-pick="${esc(t.id)}" ${full || pickPending === t.id ? 'disabled' : ''}>Choisir</button>`;
      return `<li class="track${picked ? ' is-picked' : ''}">
        <img src="${safeUrl(t.cover)}" alt="" loading="lazy">
        <div class="track-meta"><div class="t">${esc(t.title)}</div><div class="a">${esc(t.artist)}</div></div>
        <button class="icon-btn${playing ? ' playing' : ''}" data-play="${esc(t.id)}" aria-label="${playing ? 'Pause' : 'Écouter'}">${playing ? ICON_PAUSE : ICON_PLAY}</button>
        ${button}
      </li>`;
    }).join('');
  }

  async function doSearch(q) {
    const seq = ++searchSeq;
    $('searchSpinner').classList.remove('hidden');
    try {
      const found = await BYFDeezer.search(q);
      if (seq !== searchSeq) return;
      results = found;
      setSearchHint(results.length ? '' : 'Aucun résultat avec extrait.');
    } catch (_) {
      if (seq !== searchSeq) return;
      results = [];
      setSearchHint('Recherche indisponible, réessaie.');
    } finally {
      if (seq === searchSeq) $('searchSpinner').classList.add('hidden');
    }
    renderResults();
  }

  $('searchInput').addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = $('searchInput').value.trim();
    if (!q) {
      searchSeq++;
      results = [];
      $('searchSpinner').classList.add('hidden');
      setSearchHint('Tape quelque chose pour chercher.');
      return renderResults();
    }
    searchTimer = setTimeout(() => doSearch(q), 300);
  });

  $('searchInput').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    clearTimeout(searchTimer);
    const q = $('searchInput').value.trim();
    if (q) doSearch(q);
    $('searchInput').blur();
  });

  function unpick(id) {
    send('unpick', { id }, toastError);
  }

  $('results').addEventListener('click', (e) => {
    const play = e.target.closest('[data-play]');
    if (play) return togglePreview(play.dataset.play);
    const remove = e.target.closest('[data-unpick]');
    if (remove) return unpick(remove.dataset.unpick);
    const pick = e.target.closest('[data-pick]');
    if (!pick) return;
    const id = pick.dataset.pick;
    pickPending = id;
    renderResults();
    send('pick', { id }, (res) => {
      pickPending = null;
      if (res && res.error) toast(res.error);
      renderResults();
    });
  });

  $('myPicks').addEventListener('click', (e) => {
    const remove = e.target.closest('[data-unpick]');
    if (remove) unpick(remove.dataset.unpick);
  });

  // ---------------------------------------------------------------- vote

  $('guessBody').addEventListener('click', (e) => {
    const flag = e.target.closest('[data-offtheme]');
    if (flag) return send('offtheme', { flag: flag.dataset.offtheme === '1' }, toastError);
    const btn = e.target.closest('[data-vote]');
    if (!btn || btn.disabled) return;
    const targetId = btn.dataset.vote;
    // Verrouillage immédiat à l'écran, l'hôte confirme via l'état.
    $('guessBody').querySelectorAll('.vote-btn').forEach((b) => {
      b.classList.toggle('selected', b === btn);
      b.disabled = true;
    });
    // Le DOM vient d'être modifié à la main : le prochain rendu doit le reconstruire,
    // sinon le son suivant garderait ces boutons verrouillés.
    delete $('guessBody').dataset.html;
    vibrate(15);
    send('vote', { targetId }, (res) => {
      if (res && res.error) {
        toast(res.error);
        if (S && (S.phase === 'guess' || S.phase === 'deliberate')) renderGuess();
      }
    });
  });

  // ---------------------------------------------------------------- accueil / lobby

  function homeError(msg) {
    $('homeError').textContent = msg || '';
  }

  function readName() {
    const name = $('nameInput').value.replace(/\s+/g, ' ').trim().slice(0, 20);
    if (!name) {
      homeError('Choisis un pseudo.');
      $('nameInput').focus();
      return null;
    }
    store(NAME_KEY, name);
    return name;
  }

  function entered(code) {
    homeError('');
    history.replaceState(null, '', `?code=${encodeURIComponent(code)}`);
  }

  function setBusy(busy, message) {
    $('createBtn').disabled = busy;
    $('joinBtn').disabled = busy;
    if (busy) homeError('');
    $('homeStatus').textContent = busy ? message || '' : '';
  }

  // Branche l'interface sur une connexion (hôte ou invité).
  function bind(connection, name) {
    net = connection;
    const socket = connection.socket;
    socket.on('state', (state) => {
      if (net !== connection) return; // état d'une partie qu'on vient de quitter
      clockOffset = state.now - Date.now();
      for (const p of state.players) {
        if (p.avatar && p.avatar.data) avatarCache.set(`${p.id}:${p.avatar.rev}`, p.avatar.data);
      }
      S = state;
      config = state.config;
      render();
    });
    socket.on('disconnect', () => { if (net === connection) toast('Connexion perdue, reconnexion...'); });
    socket.on('reconnect', () => {
      // On reprend la même place (même pseudo + même jeton) ; le score est conservé.
      socket.emit('join', { name, token, avatar: myAvatar }, (res) => {
        if (res && res.error) goHome(`Reconnexion impossible : ${res.error}`);
        else toast('Reconnecté.');
      });
    });
    socket.on('closed', (reason) => { if (net === connection) goHome(reason); });
  }

  function enterGame(connection, name) {
    bind(connection, name);
    connection.socket.emit('join', { name, token, avatar: myAvatar }, (res) => {
      setBusy(false);
      if (res && res.error) {
        connection.close();
        net = null;
        return homeError(res.error);
      }
      entered(connection.code);
    });
  }

  $('createBtn').addEventListener('click', async () => {
    const name = readName();
    if (!name) return;
    setBusy(true, 'Création...');
    try {
      enterGame(await BYFNet.hostGame(), name);
    } catch (err) {
      setBusy(false);
      homeError(`Impossible de créer la partie : ${err.message || 'erreur réseau'}`);
    }
  });

  async function join() {
    const name = readName();
    if (!name) return;
    const code = $('codeInput').value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) {
      homeError('Le code fait 4 lettres.');
      return $('codeInput').focus();
    }
    setBusy(true, 'Connexion...');
    try {
      enterGame(await BYFNet.joinGame(code), name);
    } catch (err) {
      setBusy(false);
      homeError(err.message);
    }
  }

  $('joinBtn').addEventListener('click', join);
  $('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  $('codeInput').addEventListener('input', () => {
    $('codeInput').value = $('codeInput').value.toUpperCase().replace(/[^A-Z]/g, '');
  });
  $('nameInput').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if ($('codeInput').value.trim()) join();
    else $('createBtn').click();
  });

  // En blind test, l'hôte charge d'abord les sons : le bouton patiente pendant ce temps.
  function start(btn) {
    const label = btn.textContent;
    btn.disabled = true;
    if (Catalog.isQuiz(S.settings.mode)) btn.textContent = 'Chargement des sons...';
    send('start', null, (res) => {
      btn.textContent = label;
      btn.disabled = false;
      toastError(res);
    });
  }
  $('startBtn').addEventListener('click', () => start($('startBtn')));
  $('restartBtn').addEventListener('click', () => start($('restartBtn')));

  $('lobbyCode').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(S.code);
      toast('Code copié.');
    } catch (_) { /* presse-papiers indisponible : le code reste affiché */ }
  });

  $('shareBtn').addEventListener('click', async () => {
    const url = inviteUrl(S.code);
    if (navigator.share) {
      try {
        await navigator.share({ title: 'BlindYourFriends', text: `Rejoins ma partie (code ${S.code})`, url });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('Lien copié.');
    } catch (_) {
      $('inviteLink').select();
      toast('Copie le lien sélectionné.');
    }
  });

  function goHome(message) {
    if (net) net.close();
    net = null;
    S = null;
    stopGame();
    stopPreview();
    history.replaceState(null, '', location.pathname);
    render();
    homeError(message || '');
  }

  document.querySelectorAll('[data-action="leave"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      // L'hôte fait tourner la partie : s'il part, elle s'arrête pour tout le monde.
      if (net && !net.isHost) send('leave');
      goHome();
    });
  });

  // ---------------------------------------------------------------- photo de profil

  const AVATAR_KEY = 'blindyourfriends.avatar';
  const AVATAR_MAX = 48000; // même limite que l'hôte
  const PRESET_COUNT = 8;
  let myAvatar = null; // { kind: 'preset', style, seed } | { kind: 'image', source, data, mc? } | null
  let presetStyle = Catalog.AVATAR_STYLES[0].id;
  let presetSalt = '';
  let pendingMc = null;
  let pendingUpload = null;

  try {
    const saved = JSON.parse(load(AVATAR_KEY) || 'null');
    if (saved && (saved.kind === 'preset' || saved.kind === 'image')) myAvatar = saved;
  } catch (_) { /* avatar enregistré illisible : on repart de l'initiale */ }

  const currentName = () => (S && S.players.find((p) => p.id === S.you) || {}).name || $('nameInput').value.trim() || 'Joueur';

  function myAvatarHtml() {
    if (myAvatar && myAvatar.kind === 'preset') return imageAvatar(Catalog.avatarUrl(myAvatar.style, myAvatar.seed));
    if (myAvatar && myAvatar.kind === 'image') return imageAvatar(myAvatar.data);
    return initialAvatar(currentName());
  }

  function renderProfile() {
    $('profilePreview').innerHTML = myAvatarHtml();
    $('avatarCurrent').innerHTML = myAvatarHtml();
    $('nonePreview').innerHTML = initialAvatar(currentName());
  }

  function applyAvatar(avatar) {
    myAvatar = avatar;
    store(AVATAR_KEY, avatar ? JSON.stringify(avatar) : null);
    renderProfile();
    if (net) {
      send('avatar', { avatar }, (res) => {
        if (res && res.error) toast(res.error);
        else toast('Photo de profil mise à jour.');
      });
    } else {
      toast('Photo de profil enregistrée.');
    }
    closeAvatar();
  }

  function renderPresets() {
    $('styleChips').innerHTML = Catalog.AVATAR_STYLES.map((st) =>
      `<button class="style-chip${st.id === presetStyle ? ' on' : ''}" data-style="${st.id}" type="button">${esc(st.label)}</button>`).join('');
    const base = currentName();
    const seeds = Array.from({ length: PRESET_COUNT }, (_, i) => (i === 0 && !presetSalt ? base : `${base}-${presetSalt}${i}`));
    $('presetGrid').innerHTML = seeds.map((seed) => {
      const chosen = myAvatar && myAvatar.kind === 'preset' && myAvatar.style === presetStyle && myAvatar.seed === seed;
      return `<button class="preset${chosen ? ' on' : ''}" data-seed="${esc(seed)}" type="button" aria-label="Choisir cet avatar">
          <img src="${esc(Catalog.avatarUrl(presetStyle, seed))}" alt="" loading="lazy">
        </button>`;
    }).join('');
  }

  function showTab(tab) {
    document.querySelectorAll('#avatarModal .tab').forEach((t) => {
      const on = t.dataset.tab === tab;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('#avatarModal .tab-panel').forEach((pnl) => pnl.classList.toggle('hidden', pnl.dataset.panel !== tab));
    if (tab === 'preset') renderPresets();
  }

  function openAvatar() {
    renderProfile();
    let tab = 'preset';
    if (myAvatar && myAvatar.kind === 'image') tab = myAvatar.source === 'minecraft' ? 'minecraft' : 'upload';
    if (myAvatar && myAvatar.kind === 'preset') presetStyle = myAvatar.style;
    if (myAvatar && myAvatar.mc) $('mcInput').value = myAvatar.mc;
    showTab(tab);
    $('avatarModal').classList.remove('hidden');
  }

  function closeAvatar() {
    $('avatarModal').classList.add('hidden');
  }

  $('profileBtn').addEventListener('click', openAvatar);
  document.querySelectorAll('[data-open-avatar]').forEach((b) => b.addEventListener('click', openAvatar));
  document.querySelectorAll('[data-close-avatar]').forEach((b) => b.addEventListener('click', closeAvatar));
  $('avatarModal').addEventListener('click', (e) => { if (e.target === $('avatarModal')) closeAvatar(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('avatarModal').classList.contains('hidden')) closeAvatar();
  });
  document.querySelectorAll('#avatarModal .tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
  $('nameInput').addEventListener('input', () => renderProfile());

  // Avatars générés : un style, plusieurs variantes, un clic pour choisir.
  $('styleChips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-style]');
    if (!chip) return;
    presetStyle = chip.dataset.style;
    renderPresets();
  });
  $('presetGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-seed]');
    if (btn) applyAvatar({ kind: 'preset', style: presetStyle, seed: btn.dataset.seed });
  });
  $('presetShuffle').addEventListener('click', () => {
    presetSalt = Math.random().toString(36).slice(2, 6);
    renderPresets();
  });

  // Skin Minecraft : on affiche le rendu, le joueur confirme.
  function mcStatus(text, kind) {
    $('mcStatus').textContent = text;
    $('mcStatus').className = `answer-feedback${kind ? ` ${kind}` : ''}`;
  }
  $('mcForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('mcInput').value.trim();
    if (!name) return mcStatus('Écris ton pseudo Minecraft.', 'bad');
    $('mcBtn').disabled = true;
    $('mcPreview').classList.add('hidden');
    mcStatus('Recherche du skin...', '');
    try {
      const r = await BYFMinecraft.avatarFor(name);
      pendingMc = { kind: 'image', source: 'minecraft', data: r.data, mc: r.name };
      $('mcImg').src = r.data;
      $('mcPreview').classList.remove('hidden');
      mcStatus(`Skin de ${r.name}`, 'good');
    } catch (err) {
      mcStatus(err.message || 'Skin introuvable.', 'bad');
    } finally {
      $('mcBtn').disabled = false;
    }
  });
  $('mcUse').addEventListener('click', () => { if (pendingMc) applyAvatar(pendingMc); });

  // Image personnelle : recadrée en carré et compressée sur l'appareil avant envoi.
  async function squareImage(file) {
    const bitmap = await createImageBitmap(file);
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    for (const size of [160, 128, 96]) {
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
      for (const quality of [0.85, 0.7, 0.55]) {
        let data = canvas.toDataURL('image/webp', quality);
        if (!data.startsWith('data:image/webp')) data = canvas.toDataURL('image/jpeg', quality);
        if (data.length <= AVATAR_MAX) return data;
      }
    }
    throw new Error('Image trop lourde.');
  }
  $('uploadInput').addEventListener('change', async () => {
    const file = $('uploadInput').files[0];
    $('uploadInput').value = '';
    if (!file) return;
    const status = $('uploadStatus');
    $('uploadPreview').classList.add('hidden');
    if (file.size > 15 * 1024 * 1024) {
      status.textContent = 'Image trop lourde (15 Mo maximum).';
      status.className = 'answer-feedback bad';
      return;
    }
    try {
      const data = await squareImage(file);
      pendingUpload = { kind: 'image', source: 'upload', data };
      $('uploadImg').src = data;
      $('uploadPreview').classList.remove('hidden');
      status.textContent = '';
    } catch (_) {
      status.textContent = 'Impossible de lire cette image.';
      status.className = 'answer-feedback bad';
    }
  });
  $('uploadUse').addEventListener('click', () => { if (pendingUpload) applyAvatar(pendingUpload); });
  $('noneUse').addEventListener('click', () => applyAvatar(null));

  // ---------------------------------------------------------------- timer

  let lastSecs = -1;
  function tick() {
    requestAnimationFrame(tick);
    if (!S || !S.endsAt) return document.body.classList.remove('hurry');
    const remaining = Math.max(0, S.endsAt - (Date.now() + clockOffset));
    const frac = S.duration ? Math.min(1, remaining / S.duration) : 0;
    $('timerBar').style.strokeDashoffset = String(CIRC * (1 - frac));
    const secs = Math.ceil(remaining / 1000);
    if (secs !== lastSecs) {
      lastSecs = secs;
      $('timerText').textContent = secs;
    }
    $('timer').classList.toggle('danger', remaining > 0 && remaining <= 5000);
    // Ambiance d'urgence, sauf pendant les courtes étapes du blind test progressif.
    const urgent = ['pick', 'guess', 'deliberate'].includes(S.phase) && !S.stage && remaining > 0 && remaining <= 5000;
    document.body.classList.toggle('hurry', urgent);
  }
  $('timerBar').style.strokeDasharray = String(CIRC);
  requestAnimationFrame(tick);

  // ---------------------------------------------------------------- init

  // Le tuto s'ouvre à côté du jeu ; depuis le lanceur, dans sa version en ligne.
  const publicUrl = (window.BYF_CONFIG || {}).publicUrl;
  if (publicUrl) document.querySelectorAll('[data-tuto]').forEach((a) => { a.href = `${publicUrl}tuto.html`; });

  $('nameInput').value = load(NAME_KEY) || '';
  renderProfile();
  const urlCode = new URLSearchParams(location.search).get('code');
  if (urlCode) $('codeInput').value = urlCode.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  render();
  if (!$('nameInput').value) $('nameInput').focus();
})();
