'use strict';

// Simulation d'une partie à 3 joueurs sur le moteur de jeu (public/game.js), sans réseau.
// Les sons viennent vraiment de l'API Deezer. Durées raccourcies pour aller vite.
//   node test/simulate.js

const BYFGame = require('../public/game.js');

const CONFIG = { pickTime: 8, guessTime: 3, deliberateTime: 2, revealTime: 1 };
let failures = 0;

function check(cond, label) {
  if (cond) console.log(`  ok    ${label}`);
  else {
    failures++;
    console.log(`  ECHEC ${label}`);
  }
}

// ------------------------------------------------------------ Deezer (côté Node)

const trackCache = new Map();

function toTrack(t) {
  if (!t || !t.id || typeof t.preview !== 'string' || !t.preview.startsWith('https://')) return null;
  const album = t.album || {};
  return {
    id: String(t.id),
    title: String(t.title_short || t.title || ''),
    artist: String((t.artist && t.artist.name) || ''),
    album: String(album.title || ''),
    cover: String(album.cover_medium || ''),
    coverBig: String(album.cover_big || ''),
    preview: t.preview,
  };
}

async function deezer(path) {
  const data = await (await fetch(`https://api.deezer.com${path}`)).json();
  if (data.error) throw new Error(data.error.message);
  return data;
}

async function search(q) {
  const results = (await deezer(`/search?q=${encodeURIComponent(q)}&limit=10`)).data.map(toTrack).filter(Boolean);
  results.forEach((t) => trackCache.set(t.id, t));
  return results;
}

async function resolveTrack(id) {
  if (trackCache.has(id)) return trackCache.get(id);
  return toTrack(await deezer(`/track/${id}`));
}

// ------------------------------------------------------------ Joueurs simulés

const clients = new Map(); // id -> client
const room = BYFGame.createRoom({
  code: BYFGame.makeCode(),
  config: CONFIG,
  resolveTrack,
  // Livraison asynchrone, comme sur le réseau.
  send: (pid, state) => {
    const c = clients.get(pid);
    if (c) setImmediate(() => c.receive(state));
  },
});

let nextId = 0;
function client(label) {
  const c = { label, id: `p${++nextId}`, token: `jeton-${label}-${nextId}`, states: [], waiters: [] };
  c.receive = (st) => {
    c.states.push(st);
    c.waiters = c.waiters.filter((w) => !w.test(st));
  };
  Object.defineProperty(c, 'state', { get: () => c.states[c.states.length - 1] });
  clients.set(c.id, c);
  return c;
}

// Attend un état qui vérifie `pred`, en regardant aussi ceux reçus depuis `since`.
function waitFor(c, pred, what, since = c.states.length - 1, ms = 20000) {
  for (let i = Math.max(0, since); i < c.states.length; i++) if (pred(c.states[i])) return Promise.resolve(c.states[i]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${c.label}: timeout en attendant ${what}`)), ms);
    c.waiters.push({ test: (st) => (pred(st) ? (clearTimeout(timer), resolve(st), true) : false) });
  });
}

const emit = (c, event, payload) => room.handle(c.id, event, payload);
const join = (c, name, token = c.token) => emit(c, 'join', { name, token });
function disconnect(c) {
  clients.delete(c.id);
  room.disconnect(c.id);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('Simulation du moteur de jeu\n');
  const A = client('Alice');
  const B = client('Bob');
  let C = client('Chloé');
  let all = [A, B, C];

  // ------------------------------------------------------------ Lobby
  console.log('Lobby');
  check(/^[A-HJ-NP-Z]{4}$/.test(room.code), `code à 4 lettres sans I/O (${room.code})`);
  check((await join(A, 'Alice')).ok, "Alice crée la partie (elle est l'hôte)");
  check((await join(B, 'Bob')).ok, 'Bob rejoint');
  check(/déjà pris/.test((await join(C, 'ALICE')).error || ''), 'pseudo en double refusé (casse ignorée)');
  check((await join(C, 'Chloé   un pseudo beaucoup trop long')).ok, 'Chloé rejoint');
  await Promise.all(all.map((c) => waitFor(c, (s) => s.players.length === 3, '3 joueurs', 0)));
  check(A.state.hostId === A.id, "Alice est l'hôte");
  check(C.state.players.find((p) => p.id === C.id).name.length <= 20, 'pseudo tronqué à 20 caractères');
  const chloeName = C.state.players.find((p) => p.id === C.id).name;

  // Reprise de place : même pseudo + même jeton alors que l'ancienne connexion n'est pas encore tombée.
  const intrus = client('Intrus');
  check(/déjà pris/.test((await join(intrus, chloeName.toUpperCase(), 'mauvais-jeton')).error || ''), 'même pseudo sans le bon jeton : refusé');
  clients.delete(intrus.id);
  const C1 = client('Chloé (reco)');
  C1.token = C.token;
  check((await join(C1, chloeName)).ok, 'même pseudo + même jeton : Chloé reprend sa place');
  clients.delete(C.id);
  C = C1;
  all = [A, B, C];
  const afterReco = await waitFor(A, (s) => s.players.some((p) => p.id === C.id), 'nouvelle connexion de Chloé');
  check(afterReco.players.length === 3, "l'ancienne connexion de Chloé a été libérée");

  check(/hôte/.test((await emit(B, 'settings', { songsPerPlayer: 3 })).error || ''), "seul l'hôte règle le nombre de sons");
  check(!!(await emit(A, 'settings', { songsPerPlayer: 6 })).error, 'nombre de sons hors bornes refusé');
  check((await emit(A, 'settings', { songsPerPlayer: 2 })).ok, "l'hôte règle 2 sons par joueur");
  check(!!(await waitFor(C, (s) => s.settings.songsPerPlayer === 2, 'réglage diffusé', 0, 3000)), 'le réglage est diffusé à tous');
  check(/hôte/.test((await emit(B, 'start')).error || ''), "seul l'hôte peut lancer");
  check(/inconnue/.test((await emit(A, 'hack', {})).error || ''), 'action inconnue refusée');

  const expected = { [A.id]: 0, [B.id]: 0, [C.id]: 0 };

  // ------------------------------------------------------------ Manche 1 : pick
  console.log('\nManche 1 : préparation (2 sons chacun)');
  check((await emit(A, 'start')).ok, "l'hôte lance la manche");
  const pick = await waitFor(C, (s) => s.phase === 'pick', 'pick');
  check(Math.round(pick.duration / 1000) === 16, `durée du pick = 2 x pickTime (${pick.duration / 1000} s)`);

  const [ra, rb, rc] = await Promise.all([search('daft punk'), search('queen'), search('stromae')]);
  check(ra.length >= 4 && rb.length >= 3 && rc.length >= 2, `recherches OK (${ra.length}/${rb.length}/${rc.length})`);
  check(/invalide/.test((await emit(C, 'pick', { id: 'https://evil.example/x.mp3' })).error || ''), 'pick avec une URL refusé');
  check(!!(await emit(C, 'pick', { id: '1' })).error, 'pick avec un id inexistant refusé');

  check((await emit(A, 'pick', { id: ra[0].id })).ok, 'Alice choisit son 1er son');
  check(/déjà choisi/.test((await emit(A, 'pick', { id: ra[0].id })).error || ''), 'le même son deux fois est refusé');
  check((await emit(A, 'pick', { id: ra[1].id })).ok, 'Alice choisit son 2e son');
  check(/Retires-en/.test((await emit(A, 'pick', { id: ra[2].id })).error || ''), 'un 3e son est refusé');
  check((await emit(A, 'unpick', { id: ra[1].id })).ok, 'Alice retire un son');
  check((await emit(A, 'pick', { id: ra[2].id })).ok, 'Alice en choisit un autre à la place');
  const aPicks = await waitFor(A, (s) => (s.myPicks || []).length === 2 && s.myPicks[1].id === ra[2].id, 'choix d’Alice', 0, 3000);
  check(aPicks.myPicks.map((t) => t.id).join() === [ra[0].id, ra[2].id].join(), 'Alice voit ses 2 choix');

  const bState = await waitFor(B, (s) => s.players.find((p) => p.id === A.id).picked === 2, 'avancement d’Alice vu par Bob');
  check(bState.myPicks.length === 0 && !JSON.stringify(bState).includes(ra[0].preview), "Bob voit qu'Alice a fini, pas ses sons");
  await emit(B, 'pick', { id: rb[0].id });
  await emit(B, 'pick', { id: rb[1].id });
  await emit(C, 'pick', { id: rc[0].id });
  await sleep(20);
  check(C.state.phase === 'pick', 'un joueur incomplet bloque le passage');
  const tLastPick = Date.now();
  await emit(C, 'pick', { id: rc[1].id });

  const owners = new Map([
    [ra[0].id, A], [ra[2].id, A],
    [rb[0].id, B], [rb[1].id, B],
    [rc[0].id, C], [rc[1].id, C],
  ]);

  // ------------------------------------------------------------ Manche 1 : écoute / délibération / reveal
  const first = await waitFor(A, (s) => s.phase === 'guess', 'guess');
  check(Date.now() - tLastPick < 2000, 'tous les sons choisis : passage direct en écoute');
  check(first.sound.total === 6, '6 sons à deviner (3 joueurs x 2)');
  check(first.candidates.length === 2, 'on vote parmi les 2 autres joueurs');

  // Scénarios tournants sur les 6 sons.
  const scenarios = ['accord', 'ralliement', 'desaccord', 'abstention', 'accord', 'desaccord'];
  for (let k = 1; k <= 6; k++) {
    const since = all.map((c) => c.states.length - 1);
    const gs = await Promise.all(all.map((c, i) => waitFor(c, (s) => s.phase === 'guess' && s.sound.index === k, `son ${k}`, since[i])));
    const scenario = scenarios[k - 1];
    console.log(`\nManche 1, son ${k}/6 : ${scenario} (« ${gs[0].sound.track.title} »)`);
    const mine = all.filter((c, i) => gs[i].isMine);
    const owner = owners.get(gs[0].sound.track.id);
    check(mine.length === 1 && mine[0] === owner, `seul ${owner.label} voit « C'est ton son »`);
    check(!JSON.stringify(gs.find((s) => !s.isMine)).includes('ownerId'), "l'état d'écoute ne trahit pas le proprio");
    check(!!(await emit(owner, 'vote', { targetId: owner.id })).error, 'le proprio ne peut pas voter');
    const ownerId = owner.id;
    const [X, Y] = all.filter((c) => c !== owner);
    const markA = A.states.length - 1;
    const t0 = Date.now();

    if (scenario === 'accord') {
      await emit(X, 'vote', { targetId: Y.id }); // X change d'avis avant la fin
      await emit(X, 'vote', { targetId: ownerId });
      await emit(Y, 'vote', { targetId: ownerId });
      expected[X.id] += 100;
      expected[Y.id] += 100;
    } else if (scenario === 'ralliement') {
      await emit(X, 'vote', { targetId: ownerId });
      await emit(Y, 'vote', { targetId: X.id });
      const d = await waitFor(A, (s) => s.phase === 'deliberate', 'délibération');
      check(Date.now() - t0 < 1500, 'tout le monde a voté sans être d’accord : délibération immédiate');
      check(d.tally.length === 2 && d.tally.every((t) => t.count === 1), 'répartition des votes affichée (1 / 1)');
      check(!JSON.stringify(d.tally).includes('voterId'), 'répartition anonyme');
      await emit(Y, 'vote', { targetId: ownerId });
      expected[X.id] += 100;
      expected[Y.id] += 100;
    } else if (scenario === 'desaccord') {
      await emit(X, 'vote', { targetId: ownerId });
      await emit(Y, 'vote', { targetId: X.id });
      expected[X.id] += 100;
      expected[ownerId] += 50;
    } else if (scenario === 'abstention') {
      await emit(X, 'vote', { targetId: ownerId });
      expected[X.id] += 100;
    }

    const rs = await waitFor(A, (s) => s.phase === 'reveal' && s.sound.index === k, `reveal ${k}`);
    const elapsed = Date.now() - t0;
    const deliberated = A.states.slice(markA + 1).some((s) => s.phase === 'deliberate');

    if (scenario === 'accord') {
      check(!deliberated && elapsed < 1500, `unanimes : reveal immédiat sans délibération (${elapsed} ms)`);
    } else if (scenario === 'ralliement') {
      check(deliberated && elapsed < 1500, `ralliement pendant la délibération : reveal immédiat (${elapsed} ms)`);
    } else if (scenario === 'desaccord') {
      check(deliberated && elapsed >= 1800, `désaccord maintenu : reveal à la fin de la délibération (${elapsed} ms)`);
    } else if (scenario === 'abstention') {
      check(!deliberated && elapsed >= 2500, `un seul avis : pas de délibération, reveal au timeout (${elapsed} ms)`);
    }

    check(rs.reveal.ownerId === ownerId, `reveal : c'était ${rs.reveal.ownerName}`);
    check(rs.players.every((p) => p.score === expected[p.id]), `scores : ${rs.players.map((p) => `${p.name}=${p.score}`).join(', ')}`);
  }

  const end1 = await waitFor(A, (s) => s.phase === 'end', 'end');
  console.log('\nFin de manche 1');
  check(end1.endsAt === 0, 'pas de timer en fin de manche');
  check(end1.players.every((p) => p.score === expected[p.id]), 'scores finaux conformes');

  // ------------------------------------------------------------ Manche 2 : 1 son, déconnexion + retour
  console.log('\nManche 2 : 1 son chacun, déconnexion pendant la préparation');
  check((await emit(A, 'settings', { songsPerPlayer: 1 })).ok, "l'hôte repasse à 1 son en fin de manche");
  check((await emit(A, 'start')).ok, "l'hôte relance une manche");
  await Promise.all(all.map((c) => waitFor(c, (s) => s.phase === 'pick' && s.round === 2, 'pick manche 2')));
  await emit(A, 'pick', { id: ra[3].id });
  await emit(B, 'pick', { id: rb[2].id });
  await sleep(50);
  check(A.state.phase === 'pick', "Chloé n'a pas choisi : on reste en préparation");
  const chloeScore = expected[C.id];
  disconnect(C);
  delete expected[C.id];
  const g = await waitFor(A, (s) => s.phase === 'guess', 'écoute après départ de Chloé');
  check(g.players.length === 2 && g.sound.total === 2, 'Chloé retirée, vérif relancée : passage direct en écoute');

  const C2 = client('Chloé (retour)');
  check((await join(C2, chloeName.toLowerCase())).ok, 'Chloé revient en cours de manche');
  const c2s = await waitFor(C2, (s) => s.phase === 'guess', 'état pour Chloé');
  check(c2s.players.find((p) => p.id === C2.id).score === chloeScore, `score de Chloé restauré (${chloeScore})`);
  check(c2s.canVote === false && !!(await emit(C2, 'vote', { targetId: A.id })).error, 'Chloé ne vote pas avant la prochaine manche');
  expected[C2.id] = chloeScore;

  for (let k = 1; k <= 2; k++) {
    const s = await waitFor(A, (st) => st.round === 2 && st.phase === 'guess' && st.sound.index === k, `son ${k}`, 0);
    const voter = s.isMine ? B : A;
    const ownerId = voter === A ? B.id : A.id;
    await emit(voter, 'vote', { targetId: ownerId });
    expected[voter.id] += 100;
    const rs = await waitFor(A, (st) => st.round === 2 && st.phase === 'reveal' && st.sound.index === k, `reveal ${k}`);
    check(rs.reveal.ownerId === ownerId, `son ${k} : ${voter.label} trouve, reveal immédiat`);
  }
  const end2 = await waitFor(A, (s) => s.phase === 'end' && s.round === 2, 'fin manche 2');
  check(end2.players.every((p) => p.score === expected[p.id]), `scores cumulés : ${end2.players.map((p) => `${p.name}=${p.score}`).join(', ')}`);

  // ------------------------------------------------------------ Départs
  console.log('\nDéparts');
  disconnect(A);
  const bs = await waitFor(B, (s) => s.players.length === 2, "départ d'Alice");
  check(bs.hostId === B.id, "l'hôte est transféré à Bob");
  check((await emit(C2, 'leave')).ok, 'Chloé quitte');
  disconnect(B);
  check(room.playerCount === 0, 'partie vide');
  room.destroy();
  check(/terminée/.test((await join(client('Dave'), 'Dave')).error || ''), 'plus personne ne peut rejoindre une partie fermée');

  console.log(failures ? `\n${failures} échec(s).` : '\nTout est bon.');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('\nErreur :', err.message);
  process.exit(1);
});
