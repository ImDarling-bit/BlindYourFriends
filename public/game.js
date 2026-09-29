// Moteur de jeu BlindYourFriends : la machine à états d'une partie.
// Tourne chez l'hôte (navigateur ou lanceur) et dans Node pour les tests.
// Aucune dépendance au transport : on lui passe des messages, il renvoie des états.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BYFGame = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    pickTime: 30, // secondes par son à choisir
    guessTime: 30,
    deliberateTime: 30,
    revealTime: 7,
    songsMin: 1,
    songsMax: 5,
    songsDefault: 2,
    minPlayers: 2,
    maxPlayers: 12,
    pointsGoodGuess: 100,
    pointsPerFooled: 50,
  };
  const NAME_MAX = 20;
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

  function cleanName(raw) {
    return String(raw || '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, NAME_MAX);
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
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
   * - send(playerId, state) : envoie l'état personnalisé d'un joueur
   * Les ids de joueur sont ceux des connexions, fournis par le transport.
   */
  function createRoom({ code, config, resolveTrack, send }) {
    const cfg = Object.assign({}, DEFAULTS, config || {});
    const PICK_MS = cfg.pickTime * 1000;
    const GUESS_MS = cfg.guessTime * 1000;
    const DELIBERATE_MS = cfg.deliberateTime * 1000;
    const REVEAL_MS = cfg.revealTime * 1000;
    const publicConfig = Object.freeze(Object.assign({}, cfg));

    const room = {
      code,
      hostId: null,
      players: new Map(), // id -> { id, name, token, score, active }
      settings: { songsPerPlayer: cfg.songsDefault },
      phase: 'lobby',
      round: 0,
      endsAt: 0,
      phaseMs: 0,
      timer: null,
      picks: new Map(), // playerId -> track[]
      sounds: [], // [{ ownerId, track }] dans l'ordre de passage
      idx: -1,
      current: null, // sounds[idx]
      votes: new Map(), // voterId -> targetId
      reveal: null,
      pastScores: new Map(), // pseudo (minuscule) -> score, pour qui revient après une déconnexion
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

    const inGame = () => ['pick', 'guess', 'deliberate', 'reveal'].includes(room.phase);
    const isVoting = () => room.phase === 'guess' || room.phase === 'deliberate';
    const activePlayers = () => [...room.players.values()].filter((p) => p.active);
    const voters = () => activePlayers().filter((p) => p.id !== room.current.ownerId);
    // Joueurs pour qui on peut voter : ceux qui ont au moins un son dans la manche.
    const candidates = () => [...new Set(room.sounds.map((s) => s.ownerId))].filter((id) => room.players.has(id));
    // Les votants qui se sont prononcés ne désignent pas tous la même personne.
    const disagree = () => new Set(room.votes.values()).size > 1;
    const allVoted = () => voters().every((p) => room.votes.has(p.id));

    function startRound() {
      room.round++;
      room.picks.clear();
      room.sounds = [];
      room.idx = -1;
      room.current = null;
      room.votes.clear();
      room.reveal = null;
      for (const p of room.players.values()) p.active = true;
      room.phase = 'pick';
      schedule(PICK_MS * room.settings.songsPerPlayer, endPick);
      broadcast();
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
      room.reveal = null;
      room.idx++;
      while (room.idx < room.sounds.length && !room.players.has(room.sounds[room.idx].ownerId)) room.idx++;
      if (room.idx >= room.sounds.length) return endGame();

      room.current = room.sounds[room.idx];
      room.phase = 'guess';
      schedule(GUESS_MS, endListen);
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

      for (const [voterId, targetId] of room.votes) {
        const voter = room.players.get(voterId);
        if (!voter) continue;
        const correct = targetId === ownerId;
        if (correct) {
          voter.score += cfg.pointsGoodGuess;
          gains[voterId] = cfg.pointsGoodGuess;
        } else {
          fooled++;
        }
        const target = room.players.get(targetId);
        votes.push({ voterId, voterName: voter.name, targetId, targetName: target ? target.name : '?', correct });
      }
      if (owner && fooled) {
        owner.score += fooled * cfg.pointsPerFooled;
        gains[ownerId] = fooled * cfg.pointsPerFooled;
      }

      room.reveal = { ownerId, ownerName: owner ? owner.name : '?', track: publicTrack(track), votes, gains };
      room.phase = 'reveal';
      schedule(REVEAL_MS, nextSound);
      broadcast();
    }

    function endGame() {
      room.phase = 'end';
      room.current = null;
      room.votes.clear();
      schedule(0);
      broadcast();
    }

    // Relance la vérif "tout le monde a joué" (après un pick, un vote ou un départ).
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
      }
      broadcast();
    }

    // État personnalisé : chaque joueur ne voit que ses propres picks.
    function stateFor(pid) {
      const me = room.players.get(pid);
      const s = {
        code: room.code,
        phase: room.phase,
        round: room.round,
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
        s.candidates = candidates()
          .filter((id) => id !== pid)
          .map((id) => ({ id, name: room.players.get(id).name }));
        if (room.phase === 'deliberate') {
          // Répartition anonyme des votes pour lancer le débat.
          const tally = {};
          for (const target of room.votes.values()) tally[target] = (tally[target] || 0) + 1;
          s.tally = candidates()
            .map((id) => ({ id, name: room.players.get(id).name, count: tally[id] || 0 }))
            .filter((t) => t.count > 0)
            .sort((a, b) => b.count - a.count);
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
      if (player.score > 0) room.pastScores.set(player.name.toLowerCase(), player.score);
      room.votes.delete(pid);
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
      return null;
    }

    function onSettings(pid, payload) {
      const err = hostCheck(pid);
      if (err) return err;
      const n = Number(payload && payload.songsPerPlayer);
      if (!Number.isInteger(n) || n < cfg.songsMin || n > cfg.songsMax) {
        return { error: `Entre ${cfg.songsMin} et ${cfg.songsMax} sons par joueur.` };
      }
      room.settings.songsPerPlayer = n;
      broadcast();
      return { ok: true };
    }

    function onStart(pid) {
      const err = hostCheck(pid);
      if (err) return err;
      if (room.players.size < cfg.minPlayers) return { error: `Il faut au moins ${cfg.minPlayers} joueurs.` };
      startRound();
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

    const handlers = {
      join: onJoin,
      settings: onSettings,
      start: onStart,
      pick: onPick,
      unpick: onUnpick,
      vote: onVote,
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
