// Moteur de jeu BlindYourFriends : la machine à états d'une partie.
// Tourne chez l'hôte (navigateur ou lanceur) et dans Node pour les tests.
// Aucune dépendance au transport : on lui passe des messages, il renvoie des états.
//
// Modes (voir catalog.js) :
// - byf / byf-theme : chacun choisit des sons (pick), puis on devine qui a mis quoi (guess,
//   deliberate, reveal). En byf-theme, un thème est imposé et on peut signaler un son hors thème.
// - classic / progressive : le jeu choisit les sons, on tape le titre et l'artiste (guess, reveal).
//   En progressive, l'extrait s'allonge par étapes et les points baissent à chaque étape.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./catalog.js'));
  else root.BYFGame = factory(root.BYFCatalog);
})(typeof self !== 'undefined' ? self : this, function (Catalog) {
  'use strict';

  const DEFAULTS = {
    pickTime: 30, // secondes par son à choisir
    guessTime: 30,
    deliberateTime: 30,
    revealTime: 7,
    songsMin: 1,
    songsMax: 5,
    songsDefault: 2,
    songCountMin: 5, // blind test : nombre de sons par manche
    songCountMax: 20,
    songCountDefault: 10,
    minPlayers: 2,
    maxPlayers: 12,
    pointsGoodGuess: 100,
    pointsPerFooled: 50,
    offThemePenalty: 100,
    quizTitlePoints: 100,
    quizArtistPoints: 100,
    quizFirstBonus: 50, // au premier qui trouve le titre (ou l'artiste)
    progressiveClips: [1, 2, 4, 8, 16, 30], // secondes d'extrait à chaque étape
    progressivePoints: [1000, 800, 600, 400, 250, 100], // moitié titre, moitié artiste
    stageGap: 5, // secondes pour répondre après chaque extrait
  };
  const NAME_MAX = 20;
  const THEME_MAX = 40;
  const ANSWER_MAX = 100;
  const ANSWER_COOLDOWN = 300; // ms entre deux réponses d'un même joueur
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // sans I ni O

  function randomInt(n) {
    const c = typeof globalThis !== 'undefined' && globalThis.crypto;
    if (c && c.getRandomValues) {
      const a = new Uint32Array(1);
      c.getRandomValues(a);
      return a[0] % n;
    }
    return Math.floor(Math.random() * n);
  }

  function makeCode() {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[randomInt(CODE_CHARS.length)];
    return code;
  }

  function cleanText(raw, max) {
    return String(raw || '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);
  }

  const cleanName = (raw) => cleanText(raw, NAME_MAX);

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // Photo de profil : avatar DiceBear (style + graine) ou image envoyée par le joueur
  // (photo ou rendu de skin Minecraft), petite image PNG/JPEG/WebP en data URL.
  const AVATAR_IMAGE_MAX = 48000; // caractères, soit ~35 Ko d'image
  const IMAGE_DATA = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

  function cleanAvatar(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.kind === 'preset') {
      if (!Catalog.avatarStyle(raw.style)) return null;
      const seed = cleanText(raw.seed, 40);
      return seed ? { kind: 'preset', style: raw.style, seed } : null;
    }
    if (raw.kind === 'image') {
      const data = String(raw.data || '');
      if (data.length > AVATAR_IMAGE_MAX || !IMAGE_DATA.test(data)) return null;
      const source = raw.source === 'minecraft' ? 'minecraft' : 'upload';
      const avatar = { kind: 'image', source, data };
      if (source === 'minecraft') avatar.mc = cleanText(raw.mc, 16);
      return avatar;
    }
    return null;
  }

  function publicTrack(t) {
    if (!t) return null;
    return { id: t.id, title: t.title, artist: t.artist, album: t.album, cover: t.cover, coverBig: t.coverBig, preview: t.preview };
  }

  /**
   * Crée une partie.
   * - code : code à 4 lettres
   * - config : durées et bornes (voir DEFAULTS)
   * - resolveTrack(id) : Promise<track|null>, résolution d'un id Deezer par l'hôte
   * - loadTracks(sourceId) : Promise<track[]>, sons d'une source du blind test (catalog.SOURCES)
   * - send(playerId, state) : envoie l'état personnalisé d'un joueur
   * Les ids de joueur sont ceux des connexions, fournis par le transport.
   */
  function createRoom({ code, config, resolveTrack, loadTracks, send }) {
    const cfg = Object.assign({}, DEFAULTS, config || {});
    const PICK_MS = cfg.pickTime * 1000;
    const GUESS_MS = cfg.guessTime * 1000;
    const DELIBERATE_MS = cfg.deliberateTime * 1000;
    const REVEAL_MS = cfg.revealTime * 1000;
    const publicConfig = Object.freeze(Object.assign({}, cfg));

    const room = {
      code,
      hostId: null,
      players: new Map(), // id -> { id, name, token, score, active, lastAnswer }
      settings: {
        mode: Catalog.DEFAULT_MODE,
        songsPerPlayer: cfg.songsDefault,
        theme: 'random', // id de catalog.THEMES, 'random' ou 'custom'
        customTheme: '',
        source: Catalog.DEFAULT_SOURCE,
        songCount: cfg.songCountDefault,
      },
      mode: Catalog.DEFAULT_MODE, // mode de la manche en cours
      theme: null, // thème de la manche en cours (texte)
      phase: 'lobby',
      round: 0,
      endsAt: 0,
      phaseMs: 0,
      timer: null,
      starting: false,
      picks: new Map(), // playerId -> track[]
      sounds: [], // [{ ownerId, track }] dans l'ordre de passage (ownerId null en blind test)
      idx: -1,
      current: null, // sounds[idx]
      votes: new Map(), // voterId -> targetId
      offTheme: new Set(), // joueurs qui jugent le son hors thème
      answers: new Map(), // playerId -> { title: points|null, artist: points|null } (blind test)
      firsts: { title: null, artist: null }, // premier à trouver, pour le bonus
      stage: 0, // étape du blind test progressif
      played: new Set(), // sons déjà joués en blind test, pour ne pas les répéter
      reveal: null,
      pastScores: new Map(), // pseudo (minuscule) -> score, pour qui revient après une déconnexion
      // Images d'avatar déjà envoyées à chaque joueur (destinataire -> joueur -> version),
      // pour ne pas renvoyer des dizaines de Ko à chaque état.
      avatarSent: new Map(),
      destroyed: false,
    };

    function schedule(ms, fn) {
      clearTimeout(room.timer);
      room.timer = null;
      room.phaseMs = ms || 0;
      room.endsAt = ms ? Date.now() + ms : 0;
      if (ms) {
        room.timer = setTimeout(() => {
          room.timer = null;
          if (!room.destroyed) fn();
        }, ms);
      }
    }

    const isQuiz = () => Catalog.isQuiz(room.mode);
    const inGame = () => ['pick', 'guess', 'deliberate', 'reveal'].includes(room.phase);
    const isVoting = () => !isQuiz() && (room.phase === 'guess' || room.phase === 'deliberate');
    const activePlayers = () => [...room.players.values()].filter((p) => p.active);
    const voters = () => activePlayers().filter((p) => p.id !== room.current.ownerId);
    // Joueurs pour qui on peut voter : ceux qui ont au moins un son dans la manche.
    const candidates = () => [...new Set(room.sounds.map((s) => s.ownerId))].filter((id) => room.players.has(id));
    // Les votants qui se sont prononcés ne désignent pas tous la même personne.
    const disagree = () => new Set(room.votes.values()).size > 1;
    const allVoted = () => voters().every((p) => room.votes.has(p.id));
    const answerOf = (pid) => room.answers.get(pid) || { title: null, artist: null };
    const foundAll = (pid) => {
      const a = answerOf(pid);
      return a.title !== null && a.artist !== null;
    };

    // ------------------------------------------------------------ déroulement

    function resetRound() {
      room.round++;
      room.mode = room.settings.mode;
      room.theme = null;
      room.picks.clear();
      room.sounds = [];
      room.idx = -1;
      room.current = null;
      room.votes.clear();
      room.offTheme.clear();
      room.reveal = null;
      // Chaque manche repart de zéro.
      room.pastScores.clear();
      for (const p of room.players.values()) {
        p.active = true;
        p.score = 0;
      }
    }

    function resolveTheme() {
      const s = room.settings;
      if (s.theme === 'custom' && s.customTheme) return s.customTheme;
      const fixed = Catalog.theme(s.theme);
      if (fixed) return fixed.label;
      return Catalog.THEMES[randomInt(Catalog.THEMES.length)].label;
    }

    function startPickRound() {
      resetRound();
      if (room.mode === 'byf-theme') room.theme = resolveTheme();
      room.phase = 'pick';
      schedule(PICK_MS * room.settings.songsPerPlayer, endPick);
      broadcast();
    }

    function startQuizRound(tracks) {
      resetRound();
      room.sounds = tracks.map((track) => ({ ownerId: null, track }));
      tracks.forEach((t) => room.played.add(t.id));
      nextSound();
    }

    function endPick() {
      const sounds = [];
      for (const [ownerId, tracks] of room.picks) {
        if (room.players.has(ownerId)) tracks.forEach((track) => sounds.push({ ownerId, track }));
      }
      room.sounds = shuffle(sounds);
      room.idx = -1;
      nextSound();
    }

    function nextSound() {
      room.votes.clear();
      room.offTheme.clear();
      room.answers.clear();
      room.firsts = { title: null, artist: null };
      room.reveal = null;
      room.idx++;
      // En blind test, les sons n'ont pas de propriétaire ; sinon on saute ceux des joueurs partis.
      while (room.idx < room.sounds.length && !isQuiz() && !room.players.has(room.sounds[room.idx].ownerId)) room.idx++;
      if (room.idx >= room.sounds.length) return endGame();

      room.current = room.sounds[room.idx];
      room.phase = 'guess';
      if (room.mode === 'progressive') return startStage(0);
      schedule(GUESS_MS, isQuiz() ? revealQuiz : endListen);
      broadcast();
    }

    // Blind test progressif : à chaque étape, un extrait plus long puis un temps pour répondre.
    function startStage(k) {
      room.stage = k;
      const last = k >= cfg.progressiveClips.length - 1;
      schedule((cfg.progressiveClips[k] + cfg.stageGap) * 1000, () => (last ? revealQuiz() : startStage(k + 1)));
      broadcast();
    }

    // Fin de l'écoute. Les votes étant définitifs, la délibération ne sert qu'aux indécis :
    // elle n'a lieu que si les premiers votes divergent et qu'il reste des joueurs sans vote.
    function endListen() {
      if (!disagree() || allVoted()) return doReveal();
      room.phase = 'deliberate';
      schedule(DELIBERATE_MS, doReveal);
      broadcast();
    }

    function doReveal() {
      const { ownerId, track } = room.current;
      const owner = room.players.get(ownerId);
      const gains = {};
      const votes = [];
      let fooled = 0;
      const add = (pid, pts) => {
        const p = room.players.get(pid);
        if (!p || !pts) return;
        p.score += pts;
        gains[pid] = (gains[pid] || 0) + pts;
      };

      for (const [voterId, targetId] of room.votes) {
        const voter = room.players.get(voterId);
        if (!voter) continue;
        const correct = targetId === ownerId;
        if (correct) add(voterId, cfg.pointsGoodGuess);
        else fooled++;
        const target = room.players.get(targetId);
        votes.push({ voterId, voterName: voter.name, targetId, targetName: target ? target.name : '?', correct });
      }
      add(ownerId, fooled * cfg.pointsPerFooled);

      // Thème imposé : si la majorité des autres joueurs juge le son hors thème, pénalité.
      let offTheme = null;
      if (room.mode === 'byf-theme') {
        const total = voters().length;
        const count = [...room.offTheme].filter((id) => room.players.has(id) && id !== ownerId).length;
        const penalized = total > 0 && count * 2 > total;
        if (penalized) add(ownerId, -cfg.offThemePenalty);
        offTheme = { count, total, penalized, penalty: penalized ? cfg.offThemePenalty : 0 };
      }

      room.reveal = { kind: 'byf', ownerId, ownerName: owner ? owner.name : '?', track: publicTrack(track), votes, gains, offTheme };
      room.phase = 'reveal';
      schedule(REVEAL_MS, nextSound);
      broadcast();
    }

    function revealQuiz() {
      const gains = {};
      const results = [];
      for (const p of activePlayers()) {
        const a = answerOf(p.id);
        const pts = (a.title || 0) + (a.artist || 0);
        if (pts) {
          p.score += pts;
          gains[p.id] = pts;
        }
        results.push({ id: p.id, name: p.name, title: a.title, artist: a.artist });
      }
      results.sort((x, y) => (gains[y.id] || 0) - (gains[x.id] || 0));
      room.reveal = { kind: 'quiz', track: publicTrack(room.current.track), results, gains };
      room.phase = 'reveal';
      schedule(REVEAL_MS, nextSound);
      broadcast();
    }

    function endGame() {
      room.phase = 'end';
      room.current = null;
      room.votes.clear();
      room.answers.clear();
      schedule(0);
      broadcast();
    }

    // Relance la vérif "tout le monde a joué" (après un pick, un vote, une réponse ou un départ).
    function checkProgress() {
      if (inGame() && room.players.size < cfg.minPlayers) return endGame();

      if (room.phase === 'pick') {
        const active = activePlayers();
        if (active.length === 0) return endGame();
        const needed = room.settings.songsPerPlayer;
        if (active.every((p) => (room.picks.get(p.id) || []).length >= needed)) return endPick();
      } else if (isVoting()) {
        if (!room.players.has(room.current.ownerId)) return nextSound(); // le proprio est parti : on saute
        if (allVoted()) return doReveal(); // plus aucun vote ne peut changer
      } else if (isQuiz() && room.phase === 'guess') {
        const active = activePlayers();
        if (active.length && active.every((p) => foundAll(p.id))) return revealQuiz();
      }
      broadcast();
    }

    // ------------------------------------------------------------ état envoyé aux joueurs

    function avatarFor(recipient, p) {
      const a = p.avatar;
      if (!a) return null;
      if (a.kind === 'preset') return { rev: p.avatarRev, kind: 'preset', style: a.style, seed: a.seed };
      let sent = room.avatarSent.get(recipient);
      if (!sent) room.avatarSent.set(recipient, (sent = new Map()));
      const out = { rev: p.avatarRev, kind: 'image', source: a.source };
      if (sent.get(p.id) !== p.avatarRev) {
        out.data = a.data;
        sent.set(p.id, p.avatarRev);
      }
      return out;
    }

    // État personnalisé : chaque joueur ne voit que ses propres picks, et jamais la réponse
    // d'un blind test avant le reveal.
    function stateFor(pid) {
      const me = room.players.get(pid);
      const s = {
        code: room.code,
        phase: room.phase,
        round: room.round,
        mode: inGame() ? room.mode : room.settings.mode,
        theme: inGame() ? room.theme : null,
        now: Date.now(),
        endsAt: room.endsAt,
        duration: room.phaseMs,
        you: pid,
        hostId: room.hostId,
        settings: Object.assign({}, room.settings),
        config: publicConfig,
        active: !!(me && me.active),
        players: [...room.players.values()].map((p) => ({
          id: p.id,
          name: p.name,
          score: p.score,
          active: p.active,
          picked: room.phase === 'pick' ? (room.picks.get(p.id) || []).length : 0,
          avatar: avatarFor(pid, p),
        })),
      };

      if (room.phase === 'pick') {
        s.myPicks = (room.picks.get(pid) || []).map(publicTrack);
      }
      if (isVoting()) {
        const isMine = room.current.ownerId === pid;
        s.sound = { index: room.idx + 1, total: room.sounds.length, track: publicTrack(room.current.track) };
        s.isMine = isMine;
        s.canVote = !!(me && me.active) && !isMine;
        s.myVote = room.votes.get(pid) || null;
        s.myOffTheme = room.offTheme.has(pid);
        s.candidates = candidates()
          .filter((id) => id !== pid)
          .map((id) => ({ id, name: room.players.get(id).name }));
        // Aucune information sur les votes des autres avant le reveal du son.
      }
      if (isQuiz() && room.phase === 'guess') {
        // Seulement l'extrait : ni titre, ni artiste, ni pochette.
        s.sound = { index: room.idx + 1, total: room.sounds.length, track: { preview: room.current.track.preview } };
        s.canAnswer = !!(me && me.active);
        s.found = answerOf(pid);
        s.progress = activePlayers().map((p) => {
          const a = answerOf(p.id);
          return { id: p.id, name: p.name, title: a.title !== null, artist: a.artist !== null };
        });
        if (room.mode === 'progressive') {
          s.stage = {
            index: room.stage,
            count: cfg.progressiveClips.length,
            clip: cfg.progressiveClips[room.stage],
            points: cfg.progressivePoints[room.stage],
          };
        }
      }
      if (room.phase === 'reveal') {
        s.sound = { index: room.idx + 1, total: room.sounds.length, track: room.reveal.track };
        s.reveal = room.reveal;
      }
      return s;
    }

    function broadcast() {
      if (room.destroyed) return;
      for (const pid of room.players.keys()) send(pid, stateFor(pid));
    }

    function removePlayer(pid) {
      const player = room.players.get(pid);
      if (!player) return;
      room.players.delete(pid);
      room.avatarSent.delete(pid);
      if (player.score !== 0) room.pastScores.set(player.name.toLowerCase(), player.score);
      room.votes.delete(pid);
      room.offTheme.delete(pid);
      if (room.phase === 'pick') room.picks.delete(pid);

      if (room.players.size === 0) {
        clearTimeout(room.timer);
        room.hostId = null;
        room.phase = 'lobby';
        return;
      }
      if (room.hostId === pid) room.hostId = room.players.keys().next().value;
      checkProgress();
    }

    // ------------------------------------------------------------ messages

    function onJoin(pid, payload) {
      const name = cleanName(payload && payload.name);
      const token = String((payload && payload.token) || '').slice(0, 64);
      if (!name) return { error: 'Choisis un pseudo.' };
      if (room.players.has(pid)) return { ok: true, code: room.code };
      const lower = name.toLowerCase();
      const taken = [...room.players.values()].find((p) => p.name.toLowerCase() === lower);
      if (taken) {
        // Même pseudo + même jeton : c'est le joueur qui revient alors que l'ancienne connexion
        // n'a pas encore été détectée comme perdue. On libère l'ancienne place.
        if (!token || taken.token !== token) return { error: 'Ce pseudo est déjà pris dans cette partie.' };
        removePlayer(taken.id);
      }
      if (room.players.size >= cfg.maxPlayers) return { error: `Partie pleine (${cfg.maxPlayers} max).` };

      room.players.set(pid, {
        id: pid,
        name,
        token,
        score: room.pastScores.get(lower) || 0,
        // Un joueur qui arrive pendant la phase pick peut encore jouer la manche.
        active: room.phase === 'pick',
        lastAnswer: 0,
        avatar: cleanAvatar(payload && payload.avatar),
        avatarRev: 1,
      });
      room.pastScores.delete(lower);
      if (!room.hostId) room.hostId = pid;
      broadcast();
      return { ok: true, code: room.code };
    }

    function hostCheck(pid) {
      if (!room.players.has(pid)) return { error: 'Pas de partie.' };
      if (room.hostId !== pid) return { error: "Seul l'hôte peut faire ça." };
      if (room.phase !== 'lobby' && room.phase !== 'end') return { error: 'Manche déjà en cours.' };
      if (room.starting) return { error: 'Lancement en cours.' };
      return null;
    }

    const intIn = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

    // Réglages envoyés un par un ou ensemble : chaque champ présent est vérifié puis appliqué.
    function onSettings(pid, payload) {
      const err = hostCheck(pid);
      if (err) return err;
      const p = payload || {};
      const next = Object.assign({}, room.settings);

      if ('mode' in p) {
        if (!Catalog.mode(p.mode)) return { error: 'Mode de jeu inconnu.' };
        next.mode = p.mode;
      }
      if ('songsPerPlayer' in p) {
        const n = Number(p.songsPerPlayer);
        if (!intIn(n, cfg.songsMin, cfg.songsMax)) return { error: `Entre ${cfg.songsMin} et ${cfg.songsMax} sons par joueur.` };
        next.songsPerPlayer = n;
      }
      if ('theme' in p) {
        if (p.theme !== 'random' && p.theme !== 'custom' && !Catalog.theme(p.theme)) return { error: 'Thème inconnu.' };
        next.theme = p.theme;
      }
      if ('customTheme' in p) next.customTheme = cleanText(p.customTheme, THEME_MAX);
      if ('source' in p) {
        if (!Catalog.source(p.source)) return { error: 'Style de musique inconnu.' };
        next.source = p.source;
      }
      if ('songCount' in p) {
        const n = Number(p.songCount);
        if (!intIn(n, cfg.songCountMin, cfg.songCountMax)) return { error: `Entre ${cfg.songCountMin} et ${cfg.songCountMax} sons.` };
        next.songCount = n;
      }

      room.settings = next;
      broadcast();
      return { ok: true };
    }

    async function onStart(pid) {
      const err = hostCheck(pid);
      if (err) return err;
      if (room.players.size < cfg.minPlayers) return { error: `Il faut au moins ${cfg.minPlayers} joueurs.` };
      const s = room.settings;
      if (s.mode === 'byf-theme' && s.theme === 'custom' && !s.customTheme) return { error: 'Écris le thème de la manche.' };
      if (!Catalog.isQuiz(s.mode)) {
        startPickRound();
        return { ok: true };
      }

      // Blind test : l'hôte récupère les sons avant de lancer.
      room.starting = true;
      let tracks = [];
      try {
        tracks = (await loadTracks(s.source)) || [];
      } catch (e) {
        console.warn('[start]', e && e.message);
      } finally {
        room.starting = false;
      }
      if (room.destroyed) return { error: 'Partie terminée.' };
      if (room.players.size < cfg.minPlayers) return { error: `Il faut au moins ${cfg.minPlayers} joueurs.` };
      const seen = new Set();
      let pool = tracks.filter((t) => t && t.preview && !seen.has(t.id) && seen.add(t.id));
      const fresh = pool.filter((t) => !room.played.has(t.id));
      if (fresh.length >= s.songCount) pool = fresh; // on évite de rejouer les mêmes sons
      if (pool.length < cfg.songCountMin) return { error: 'Pas assez de sons dans ce style, essaie-en un autre.' };
      startQuizRound(shuffle(pool).slice(0, s.songCount));
      return { ok: true };
    }

    async function onPick(pid, payload) {
      const id = String((payload && payload.id) || '');
      const player = room.players.get(pid);
      if (!player || room.phase !== 'pick') return { error: 'Trop tard pour choisir.' };
      if (!player.active) return { error: 'Tu joues à la prochaine manche.' };
      if (!/^\d{1,20}$/.test(id)) return { error: 'Son invalide.' };

      let track = null;
      try {
        track = await resolveTrack(id);
      } catch (err) {
        console.warn('[pick]', err && err.message);
      }
      if (!track) return { error: 'Son introuvable ou sans extrait.' };
      // La partie a pu changer pendant l'appel réseau.
      if (room.players.get(pid) !== player || room.phase !== 'pick') return { error: 'Trop tard pour choisir.' };

      const list = room.picks.get(pid) || [];
      const needed = room.settings.songsPerPlayer;
      if (list.some((t) => t.id === track.id)) return { error: 'Tu as déjà choisi ce son.' };
      if (list.length >= needed) return { error: `Tu as déjà tes ${needed} sons. Retires-en un pour changer.` };
      room.picks.set(pid, list.concat([track]));
      checkProgress();
      return { ok: true };
    }

    function onUnpick(pid, payload) {
      const id = String((payload && payload.id) || '');
      if (!room.players.has(pid) || room.phase !== 'pick') return { error: 'Trop tard pour changer.' };
      room.picks.set(pid, (room.picks.get(pid) || []).filter((t) => t.id !== id));
      broadcast();
      return { ok: true };
    }

    function onVote(pid, payload) {
      const targetId = String((payload && payload.targetId) || '');
      const me = room.players.get(pid);
      if (!me || !isVoting()) return { error: 'Pas de vote en cours.' };
      if (!me.active) return { error: 'Tu joues à la prochaine manche.' };
      if (room.current.ownerId === pid) return { error: "C'est ton son. Fais genre." };
      if (room.votes.has(pid)) return { error: 'Ton vote est déjà verrouillé.' };
      if (targetId === pid || !candidates().includes(targetId)) return { error: 'Vote invalide.' };
      room.votes.set(pid, targetId);
      checkProgress();
      return { ok: true };
    }

    // Thème imposé : signaler (ou retirer son signalement) qu'un son est hors thème.
    function onOffTheme(pid, payload) {
      const me = room.players.get(pid);
      if (!me || !isVoting() || room.mode !== 'byf-theme') return { error: 'Pas de thème en cours.' };
      if (!me.active || room.current.ownerId === pid) return { error: 'Tu ne peux pas juger ce son.' };
      if (payload && payload.flag) room.offTheme.add(pid);
      else room.offTheme.delete(pid);
      broadcast();
      return { ok: true };
    }

    // Blind test : une réponse tapée, comparée au titre et à l'artiste.
    function onAnswer(pid, payload) {
      const me = room.players.get(pid);
      if (!me || !isQuiz() || room.phase !== 'guess') return { error: 'Pas de son à deviner.' };
      if (!me.active) return { error: 'Tu joues à la prochaine manche.' };
      const now = Date.now();
      if (now - me.lastAnswer < ANSWER_COOLDOWN) return { error: 'Doucement !' };
      me.lastAnswer = now;

      const text = cleanText(payload && payload.text, ANSWER_MAX);
      const match = Catalog.matchAnswer(text, room.current.track);
      const a = Object.assign({}, answerOf(pid));
      const gained = {};
      for (const part of ['title', 'artist']) {
        if (!match[part] || a[part] !== null) continue;
        let pts;
        if (room.mode === 'progressive') {
          pts = Math.round(cfg.progressivePoints[room.stage] / 2);
        } else {
          pts = part === 'title' ? cfg.quizTitlePoints : cfg.quizArtistPoints;
          if (!room.firsts[part]) {
            room.firsts[part] = pid;
            pts += cfg.quizFirstBonus;
          }
        }
        a[part] = pts;
        gained[part] = pts;
      }
      room.answers.set(pid, a);
      const found = Object.keys(gained).length > 0;
      if (found) checkProgress();
      return { ok: true, found, gained, title: a.title !== null, artist: a.artist !== null };
    }

    function onAvatar(pid, payload) {
      const p = room.players.get(pid);
      const raw = payload && payload.avatar;
      const avatar = cleanAvatar(raw);
      if (raw && !avatar) return { error: 'Image refusée : trop lourde ou format non pris en charge.' };
      p.avatar = avatar;
      p.avatarRev++;
      broadcast();
      return { ok: true };
    }

    const handlers = {
      join: onJoin,
      avatar: onAvatar,
      settings: onSettings,
      start: onStart,
      pick: onPick,
      unpick: onUnpick,
      vote: onVote,
      offtheme: onOffTheme,
      answer: onAnswer,
      leave: (pid) => {
        removePlayer(pid);
        return { ok: true };
      },
    };

    return {
      code,
      config: publicConfig,
      /** Traite un message d'un joueur et renvoie la réponse (ack). */
      async handle(pid, event, payload) {
        if (room.destroyed) return { error: 'Partie terminée.' };
        const fn = Object.prototype.hasOwnProperty.call(handlers, event) ? handlers[event] : null;
        if (!fn) return { error: 'Action inconnue.' };
        if (event !== 'join' && !room.players.has(pid)) return { error: 'Pas de partie.' };
        return fn(pid, payload);
      },
      /** La connexion d'un joueur est perdue. */
      disconnect(pid) {
        removePlayer(pid);
      },
      get playerCount() {
        return room.players.size;
      },
      destroy() {
        room.destroyed = true;
        clearTimeout(room.timer);
      },
    };
  }

  return { createRoom, makeCode, cleanName, DEFAULTS, CODE_CHARS };
});
