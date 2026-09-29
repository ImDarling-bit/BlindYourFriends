(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

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

  function avatar(name) {
    const first = Array.from(String(name))[0] || '?';
    return `<span class="avatar" style="background:${colorFor(name)}">${esc(first.toUpperCase())}</span>`;
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

  // ---------------------------------------------------------------- audio

  const gameAudio = new Audio();
  gameAudio.preload = 'auto';
  gameAudio.loop = true; // l'extrait repart pendant la délibération
  const previewAudio = new Audio();
  previewAudio.preload = 'none';

  let gameKey = null; // "manche:index" du son en cours
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
    gameAudio.pause();
    $('unlockBtn').classList.add('hidden');
  }

  gameAudio.addEventListener('play', () => $('guessVinyl').classList.add('playing'));
  gameAudio.addEventListener('pause', () => $('guessVinyl').classList.remove('playing'));

  $('unlockBtn').addEventListener('click', () => {
    audioUnlocked = true;
    playGame();
  });

  function syncGameAudio() {
    const playing = S && ['guess', 'deliberate', 'reveal'].includes(S.phase);
    const sound = playing ? S.sound : null;
    if (!sound || !sound.track) return stopGame();
    const key = `${S.round}:${sound.index}`;
    if (key === gameKey) return;
    gameKey = key;
    stopPreview();
    gameAudio.src = sound.track.preview;
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
    const c = config || { pickTime: 30, guessTime: 30, deliberateTime: 30, revealTime: 7, songsMin: 1, songsMax: 5, minPlayers: 2, maxPlayers: 12, pointsGoodGuess: 100, pointsPerFooled: 50 };
    const n = songsPerPlayer();
    const songs = n
      ? `<strong>${plural(n, 'son')}</strong> (réglé par l'hôte)`
      : `entre <strong>${c.songsMin} et ${c.songsMax} sons</strong>, selon le réglage de l'hôte`;
    $('rulesList').innerHTML = `
      <li>Un joueur crée la partie et partage le code à 4 lettres. De <strong>${c.minPlayers} à ${c.maxPlayers} joueurs</strong>.</li>
      <li><strong>Préparation</strong> : chacun choisit en secret ${songs}, avec ${c.pickTime} s par son. Les autres voient ton avancement, jamais tes choix.</li>
      <li><strong>Écoute</strong> : tous les sons passent un par un, dans le désordre, <strong>${c.guessTime} s</strong> chacun. Vote pour la personne qui l'a mis. Tu peux changer d'avis.</li>
      <li>Si c'est ton son, tu ne votes pas : fais genre.</li>
      <li><strong>Délibération</strong> : si les votes ne désignent pas tous la même personne, vous avez <strong>${c.deliberateTime} s de plus</strong> pour débattre et changer vos votes.</li>
      <li><strong>Points</strong> : +${c.pointsGoodGuess} par bonne réponse. Le propriétaire du son gagne +${c.pointsPerFooled} par joueur qui s'est trompé.</li>
      <li>L'hôte peut relancer une manche à la fin : les scores se cumulent.</li>`;
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

    if (!$('rulesModal').classList.contains('hidden')) renderRules();
    document.querySelectorAll('[data-action="leave"]').forEach((b) => {
      b.textContent = net && net.isHost ? 'Fermer la partie (pour tout le monde)' : 'Quitter la partie';
    });
    syncGameAudio();
  }

  function playerRow(p) {
    const tags = [];
    if (p.id === S.hostId) tags.push('<span class="tag tag-host">Hôte</span>');
    if (p.id === S.you) tags.push('<span class="tag">Toi</span>');
    return `<li>${avatar(p.name)}<span class="player-name">${esc(p.name)}</span>${tags.join('')}</li>`;
  }

  // Bloc "sons par joueur" : modifiable par l'hôte, en lecture seule pour les autres.
  function renderSettings() {
    const n = S.settings.songsPerPlayer;
    const c = S.config;
    const control = isHost()
      ? `<div class="stepper">
          <button class="icon-btn icon-btn-small" data-songs="${n - 1}" aria-label="Moins de sons" ${n <= c.songsMin ? 'disabled' : ''}>-</button>
          <output aria-live="polite">${n}</output>
          <button class="icon-btn icon-btn-small" data-songs="${n + 1}" aria-label="Plus de sons" ${n >= c.songsMax ? 'disabled' : ''}>+</button>
        </div>`
      : `<div class="stepper"><output>${n}</output></div>`;
    const html = `<div class="settings-row">
        <div>
          <h2>Sons par joueur</h2>
          <p class="muted">${n * c.pickTime} s pour les choisir${isHost() ? '' : " · réglé par l'hôte"}</p>
        </div>
        ${control}
      </div>`;
    document.querySelectorAll('[data-settings]').forEach((el) => { el.innerHTML = html; });
  }

  document.querySelectorAll('[data-settings]').forEach((el) => {
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-songs]');
      if (!btn || btn.disabled) return;
      send('settings', { songsPerPlayer: Number(btn.dataset.songs) }, toastError);
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
    $('lobbyHint').textContent = isHost()
      ? (enough ? 'Tout le monde est là ? Lance quand tu veux.' : `Il faut au moins ${S.config.minPlayers} joueurs. Partage le code.`)
      : "En attente de l'hôte.";
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
      .map((p) => `<span class="chip${p.picked >= n ? ' done' : ''}">${avatar(p.name)}${esc(p.name)}
        <span class="count">${p.picked}/${n}</span></span>`)
      .join('');
  }

  function renderGuess() {
    const { track, index, total } = S.sound;
    const deliberating = S.phase === 'deliberate';
    $('guessCounter').textContent = `Son ${index} / ${total}${deliberating ? ' · délibération' : ''}`;
    const cover = $('guessCover');
    const coverUrl = /^https:\/\//.test(track.coverBig) ? track.coverBig : '';
    if (cover.getAttribute('src') !== coverUrl) cover.setAttribute('src', coverUrl);
    $('guessTitle').textContent = track.title;
    $('guessArtist').textContent = track.artist;

    $('deliberateBanner').classList.toggle('hidden', !deliberating);
    if (deliberating) {
      const max = Math.max(1, S.voteCount);
      $('tally').innerHTML = (S.tally || []).map((t) => `<li>
          <span class="player-name">${esc(t.name)}</span><span>${plural(t.count, 'vote')}</span>
          <span class="bar"><i style="width:${Math.round((t.count / max) * 100)}%"></i></span>
        </li>`).join('');
    }

    let body;
    if (S.isMine) {
      body = '<div class="notice"><strong>C\'est ton son.</strong><span>Fais genre.</span></div>';
    } else if (!S.canVote) {
      body = '<div class="notice"><strong>Tu joues à la prochaine manche.</strong><span>Profite du son.</span></div>';
    } else {
      body = `<p class="eyebrow center">${deliberating ? 'Ton vote final' : 'Qui a mis ça ?'}</p><div class="vote-grid">` +
        S.candidates.map((c) => `
          <button class="vote-btn${S.myVote === c.id ? ' selected' : ''}" data-vote="${esc(c.id)}">
            ${avatar(c.name)}<span>${esc(c.name)}</span>
          </button>`).join('') + '</div>';
    }
    $('guessBody').innerHTML = body;
    $('voteProgress').textContent = `${S.voteCount} / ${plural(S.voterTotal, 'vote')}`;
  }

  function rankingHtml(gains) {
    return [...S.players]
      .sort((a, b) => b.score - a.score)
      .map((p, i) => {
        const gain = gains && gains[p.id] ? `<span class="gain">+${gains[p.id]}</span>` : '';
        return `<li class="${p.id === S.you ? 'me' : ''}"><span class="rank">${i + 1}</span>${avatar(p.name)}
          <span class="player-name">${esc(p.name)}</span>${gain}<span class="score">${p.score}</span></li>`;
      })
      .join('');
  }

  function renderReveal() {
    const r = S.reveal;
    $('revealCounter').textContent = `Son ${S.sound.index} / ${S.sound.total}`;
    $('revealCover').setAttribute('src', /^https:\/\//.test(r.track.cover) ? r.track.cover : '');
    $('revealTitle').textContent = r.track.title;
    $('revealArtist').textContent = r.track.artist;

    const ownerGain = r.gains[r.ownerId] || 0;
    const fooled = r.votes.filter((v) => !v.correct).length;
    const who = r.ownerId === S.you ? 'Toi' : esc(r.ownerName);
    $('revealOwner').innerHTML = `<small>C'était</small><strong>${who}</strong>` +
      (ownerGain ? `<em>+${ownerGain} pts · ${plural(fooled, 'piégé')}</em>` : '');

    $('revealVotes').innerHTML = r.votes.length
      ? r.votes.map((v) => `<li>${avatar(v.voterName)}<span class="who">${esc(v.voterName)}</span>
          <span class="arrow">a voté</span><span>${esc(v.targetName)}</span>
          ${v.correct ? `<span class="ok">Juste +${r.gains[v.voterId] || 0}</span>` : '<span class="ko">Raté</span>'}</li>`).join('')
      : '<li class="muted">Personne n\'a voté.</li>';

    $('revealRanking').innerHTML = rankingHtml(r.gains);
  }

  function renderEnd() {
    $('endRound').textContent = `Après ${plural(S.round, 'manche')}`;
    $('endRanking').innerHTML = rankingHtml(null);
    renderSettings();
    const enough = S.players.length >= S.config.minPlayers;
    $('restartBtn').classList.toggle('hidden', !isHost());
    $('restartBtn').disabled = !enough;
    $('endHint').textContent = isHost()
      ? (enough ? 'Les scores se cumulent.' : `Il faut au moins ${S.config.minPlayers} joueurs.`)
      : "L'hôte peut relancer une manche.";
  }

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
    const btn = e.target.closest('[data-vote]');
    if (!btn) return;
    const targetId = btn.dataset.vote;
    // Retour visuel immédiat, le serveur confirme via l'état.
    $('guessBody').querySelectorAll('.vote-btn').forEach((b) => b.classList.toggle('selected', b === btn));
    send('vote', { targetId }, (res) => {
      if (res && res.error) toast(res.error);
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
      S = state;
      config = state.config;
      render();
    });
    socket.on('disconnect', () => { if (net === connection) toast('Connexion perdue, reconnexion...'); });
    socket.on('reconnect', () => {
      // On reprend la même place (même pseudo + même jeton) ; le score est conservé.
      socket.emit('join', { name, token }, (res) => {
        if (res && res.error) goHome(`Reconnexion impossible : ${res.error}`);
        else toast('Reconnecté.');
      });
    });
    socket.on('closed', (reason) => { if (net === connection) goHome(reason); });
  }

  function enterGame(connection, name) {
    bind(connection, name);
    connection.socket.emit('join', { name, token }, (res) => {
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

  $('startBtn').addEventListener('click', () => send('start', null, toastError));
  $('restartBtn').addEventListener('click', () => send('start', null, toastError));

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

  // ---------------------------------------------------------------- timer

  let lastSecs = -1;
  function tick() {
    requestAnimationFrame(tick);
    if (!S || !S.endsAt) return;
    const remaining = Math.max(0, S.endsAt - (Date.now() + clockOffset));
    const frac = S.duration ? Math.min(1, remaining / S.duration) : 0;
    $('timerBar').style.strokeDashoffset = String(CIRC * (1 - frac));
    const secs = Math.ceil(remaining / 1000);
    if (secs !== lastSecs) {
      lastSecs = secs;
      $('timerText').textContent = secs;
    }
    $('timer').classList.toggle('danger', remaining > 0 && remaining <= 5000);
  }
  $('timerBar').style.strokeDasharray = String(CIRC);
  requestAnimationFrame(tick);

  // ---------------------------------------------------------------- init

  $('nameInput').value = load(NAME_KEY) || '';
  const urlCode = new URLSearchParams(location.search).get('code');
  if (urlCode) $('codeInput').value = urlCode.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  render();
  if (!$('nameInput').value) $('nameInput').focus();
})();
