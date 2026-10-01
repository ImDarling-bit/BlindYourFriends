'use strict';

// Simulation d'une partie à 3 joueurs sur le moteur de jeu (public/game.js), sans réseau.
// Les sons viennent vraiment de l'API Deezer. Durées raccourcies pour aller vite.
//   node test/simulate.js

const BYFGame = require('../public/game.js');
const Catalog = require('../public/catalog.js');

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

// Sons du blind test ; le test garde la correspondance extrait -> son pour connaître les réponses.
const byPreview = new Map();
async function loadTracks(sourceId) {
  const src = Catalog.source(sourceId);
  const path = src.playlist ? `/playlist/${src.playlist}/tracks` : `/chart/${src.chart}/tracks`;
  const tracks = (await deezer(`${path}?limit=100`)).data
    .filter((t) => t.readable !== false)
    .map(toTrack)
    .filter(Boolean);
  tracks.forEach((t) => byPreview.set(t.preview, t));
  return tracks;
}

// ------------------------------------------------------------ Joueurs simulés

const clients = new Map(); // id -> client (ids uniques toutes parties confondues)

function makeRoom(config = CONFIG) {
  return BYFGame.createRoom({
    code: BYFGame.makeCode(),
    config,
    resolveTrack,
    loadTracks,
    // Livraison asynchrone, comme sur le réseau.
    send: (pid, state) => {
      const c = clients.get(pid);
      if (c) setImmediate(() => c.receive(state));
    },
  });
}
const room = makeRoom();

let nextId = 0;
function client(label, inRoom = room) {
  const c = { label, room: inRoom, id: `p${++nextId}`, token: `jeton-${label}-${nextId}`, states: [], waiters: [] };
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

const emit = (c, event, payload) => c.room.handle(c.id, event, payload);
const join = (c, name, token = c.token) => emit(c, 'join', { name, token });
function disconnect(c) {
  clients.delete(c.id);
  c.room.disconnect(c.id);
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
  // Avec 3 joueurs il n'y a que 2 votants : pas de délibération possible (testée plus bas à 4).
  const scenarios = ['accord', 'desaccord', 'abstention', 'accord', 'desaccord', 'abstention'];
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
      check((await emit(X, 'vote', { targetId: ownerId })).ok, `${X.label} vote`);
      check(/verrouillé/.test((await emit(X, 'vote', { targetId: Y.id })).error || ''), 'changer son vote est refusé');
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

    if (scenario === 'accord' || scenario === 'desaccord') {
      check(!deliberated && elapsed < 1500, `tout le monde a voté (${scenario}) : reveal immédiat sans délibération (${elapsed} ms)`);
    } else if (scenario === 'abstention') {
      check(!deliberated && elapsed >= 2500, `un seul avis : pas de délibération, reveal au timeout (${elapsed} ms)`);
    }
    check(!('voteCount' in gs[0]) && !('voterTotal' in gs[0]), "aucun compteur de votes pendant l'écoute");

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

  // ------------------------------------------------------------ Délibération (4 joueurs)
  console.log('\nDélibération : partie à 4 joueurs, 1 son chacun');
  const room4 = makeRoom();
  const P = ['Hugo', 'Inès', 'Jules', 'Katia'].map((n) => client(n, room4));
  for (const p of P) await join(p, p.label);
  const [H] = P;
  await emit(H, 'settings', { songsPerPlayer: 1 });
  await emit(H, 'start');
  await Promise.all(P.map((p) => waitFor(p, (s) => s.phase === 'pick', 'pick', 0)));
  const tracks4 = [ra[4], ra[5], rb[3], rc[2]];
  const owners4 = new Map(P.map((p, i) => [tracks4[i].id, p]));
  for (let i = 0; i < 4; i++) await emit(P[i], 'pick', { id: tracks4[i].id });

  const expected4 = Object.fromEntries(P.map((p) => [p.id, 0]));
  for (let k = 1; k <= 2; k++) {
    const g4 = await waitFor(H, (s) => s.phase === 'guess' && s.sound.index === k, `son ${k}`, 0);
    const owner = owners4.get(g4.sound.track.id);
    const [X, Y, Z] = P.filter((p) => p !== owner);
    const t0 = Date.now();
    await emit(X, 'vote', { targetId: owner.id });
    await emit(Y, 'vote', { targetId: X.id });
    expected4[X.id] += 100;
    expected4[owner.id] += 50;
    await sleep(300);
    check(H.state.phase === 'guess', `son ${k} : votes divergents mais ${Z.label} n'a pas voté, l'écoute continue`);
    const d = await waitFor(H, (s) => s.phase === 'deliberate' && s.sound.index === k, `délibération ${k}`);
    check(Date.now() - t0 >= 2500, `son ${k} : délibération à la fin de l'écoute`);
    check(d.tally.reduce((n, t) => n + t.count, 0) === 2 && !JSON.stringify(d.tally).includes('voterId'), 'répartition anonyme des 2 votes');
    check(/verrouillé/.test((await emit(Y, 'vote', { targetId: owner.id })).error || ''), 'pas de changement de vote en délibération');
    const t1 = Date.now();
    if (k === 1) {
      await emit(Z, 'vote', { targetId: owner.id });
      expected4[Z.id] += 100;
    }
    const r4 = await waitFor(H, (s) => s.phase === 'reveal' && s.sound.index === k, `reveal ${k}`);
    if (k === 1) check(Date.now() - t1 < 1500, `${Z.label} vote pendant la délibération : reveal immédiat`);
    else check(Date.now() - t1 >= 1500, `${Z.label} ne vote pas : reveal à la fin de la délibération`);
    check(r4.players.every((p) => p.score === expected4[p.id]), `scores : ${r4.players.map((p) => `${p.name}=${p.score}`).join(', ')}`);
  }
  room4.destroy();

  // ------------------------------------------------------------ Mode à thème
  console.log('\nMode BlindYourFriends à thème : 3 joueurs, 1 son chacun');
  const roomT = makeRoom();
  const T = ['Léa', 'Malo', 'Nina'].map((n) => client(n, roomT));
  for (const p of T) await join(p, p.label);
  check(/inconnu/.test((await emit(T[0], 'settings', { mode: 'karaoke' })).error || ''), 'mode inconnu refusé');
  check((await emit(T[0], 'settings', { mode: 'byf-theme', theme: 'custom', customTheme: '', songsPerPlayer: 1 })).ok, 'mode à thème, thème libre');
  check(/thème/.test((await emit(T[0], 'start')).error || ''), 'thème libre vide : lancement refusé');
  check((await emit(T[0], 'settings', { customTheme: '  Chanson   de   mariage  ' })).ok, 'thème libre écrit');
  check((await emit(T[0], 'start')).ok, 'manche lancée');
  const tp = await waitFor(T[1], (s) => s.phase === 'pick', 'pick à thème', 0);
  check(tp.mode === 'byf-theme' && tp.theme === 'Chanson de mariage', `thème affiché à tous (« ${tp.theme} »)`);
  const tTracks = [rb[4], rc[3], ra[6]];
  const ownersT = new Map(T.map((p, i) => [tTracks[i].id, p]));
  for (let i = 0; i < 3; i++) await emit(T[i], 'pick', { id: tTracks[i].id });
  const expectedT = Object.fromEntries(T.map((p) => [p.id, 0]));
  for (let k = 1; k <= 3; k++) {
    const g = await waitFor(T[0], (s) => s.phase === 'guess' && s.sound.index === k, `son ${k}`, 0);
    const owner = ownersT.get(g.sound.track.id);
    const [X, Y] = T.filter((p) => p !== owner);
    if (k === 1) {
      check(!!(await emit(owner, 'offtheme', { flag: true })).error, 'le proprio ne peut pas juger son propre son');
      // Les deux autres jugent le son hors thème (Y change d'avis deux fois) : pénalité.
      await emit(X, 'offtheme', { flag: true });
      await emit(Y, 'offtheme', { flag: true });
      await emit(Y, 'offtheme', { flag: false });
      await emit(Y, 'offtheme', { flag: true });
    } else if (k === 2) {
      await emit(X, 'offtheme', { flag: true }); // 1 sur 2 : pas de majorité
    }
    await emit(X, 'vote', { targetId: owner.id });
    await emit(Y, 'vote', { targetId: k === 1 ? owner.id : X.id });
    expectedT[X.id] += 100;
    if (k === 1) {
      expectedT[Y.id] += 100;
      expectedT[owner.id] -= 100;
    } else {
      expectedT[owner.id] += 50;
    }
    const r = await waitFor(T[0], (s) => s.phase === 'reveal' && s.sound.index === k, `reveal ${k}`);
    const o = r.reveal.offTheme;
    if (k === 1) check(o.penalized && o.count === 2 && r.reveal.gains[owner.id] === -100, 'hors thème pour 2 sur 2 : -100 au proprio');
    if (k === 2) check(!o.penalized && o.count === 1, 'hors thème pour 1 sur 2 : pas de pénalité');
    if (k === 3) check(!o.penalized && o.count === 0, 'personne ne signale : pas de pénalité');
    check(r.players.every((p) => p.score === expectedT[p.id]), `scores : ${r.players.map((p) => `${p.name}=${p.score}`).join(', ')}`);
  }
  roomT.destroy();

  // ------------------------------------------------------------ Blind test classique
  console.log('\nBlind test classique : 2 joueurs, 5 sons de rap');
  const roomQ = makeRoom();
  const [Q1, Q2] = ['Oscar', 'Paula'].map((n) => client(n, roomQ));
  await join(Q1, Q1.label);
  await join(Q2, Q2.label);
  check(!!(await emit(Q1, 'settings', { mode: 'classic', source: 'jazz-manouche' })).error, 'style inconnu refusé');
  check(!!(await emit(Q1, 'settings', { mode: 'classic', songCount: 3 })).error, 'nombre de sons hors bornes refusé');
  check((await emit(Q1, 'settings', { mode: 'classic', source: 'rap', songCount: 5 })).ok, 'blind test réglé (rap, 5 sons)');
  check((await emit(Q1, 'start')).ok, "l'hôte charge les sons et lance");
  const expectedQ = { [Q1.id]: 0, [Q2.id]: 0 };
  const playedQ = [];
  const say = async (c, text) => {
    await sleep(320); // au-delà de l'anti-spam
    return emit(c, 'answer', { text });
  };
  for (let k = 1; k <= 5; k++) {
    const g = await waitFor(Q2, (s) => s.phase === 'guess' && s.sound.index === k, `son ${k}`, 0);
    const track = byPreview.get(g.sound.track.preview);
    playedQ.push(track.id);
    if (k === 1) {
      check(g.sound.total === 5 && Object.keys(g.sound.track).join() === 'preview', "pendant l'écoute : seulement l'extrait, ni titre ni artiste");
      console.log(`        (réponse : ${track.artist} - ${track.title})`);
      const wrong = await say(Q1, 'zzzz pas du tout');
      check(wrong.ok && !wrong.found, 'mauvaise réponse : rien de trouvé');
      check(/Doucement/.test((await emit(Q1, 'answer', { text: 'encore' })).error || ''), 'réponses trop rapprochées refusées');
      const r1 = await say(Q1, track.title);
      check(r1.found && r1.gained.title === 150, 'Oscar trouve le titre en premier : 100 + 50 de bonus');
      const r2 = await say(Q2, track.title.toLowerCase());
      check(r2.found && r2.gained.title === 100, 'Paula trouve le titre ensuite : 100');
      const again = await say(Q1, track.title);
      check(!again.found, 'retrouver le même titre ne rapporte rien');
      const r3 = await say(Q1, track.artist);
      check(r3.gained.artist === 150, "Oscar trouve l'artiste en premier : 150");
      const prog = await waitFor(Q2, (s) => s.progress && s.progress.find((p) => p.id === Q1.id).artist, 'avancement', 0, 2000);
      check(prog.progress.find((p) => p.id === Q1.id).title, "Paula voit ce qu'Oscar a trouvé (sans la réponse)");
      expectedQ[Q1.id] += 300;
      expectedQ[Q2.id] += 100;
      const t0 = Date.now();
      await say(Q2, `${track.artist} ${track.title}`);
      expectedQ[Q2.id] += 100;
      const r = await waitFor(Q1, (s) => s.phase === 'reveal' && s.sound.index === k, 'reveal 1');
      check(Date.now() - t0 < 1000, 'tout le monde a tout trouvé : reveal immédiat');
      check(r.reveal.kind === 'quiz' && r.reveal.track.title === track.title, "le reveal montre le titre et l'artiste");
    } else if (k === 2) {
      const t0 = Date.now();
      const r = await waitFor(Q1, (s) => s.phase === 'reveal' && s.sound.index === k, 'reveal 2');
      check(Date.now() - t0 >= 2500 && Object.keys(r.reveal.gains).length === 0, 'personne ne trouve : reveal au bout du temps, 0 point');
    } else {
      await say(Q1, `${track.artist} ${track.title}`);
      await say(Q2, `${track.title} ${track.artist}`);
      expectedQ[Q1.id] += 300;
      expectedQ[Q2.id] += 200;
      await waitFor(Q1, (s) => s.phase === 'reveal' && s.sound.index === k, `reveal ${k}`);
    }
    await sleep(20);
    check(Q1.state.players.every((p) => p.score === expectedQ[p.id]), `son ${k} : ${Q1.state.players.map((p) => `${p.name}=${p.score}`).join(', ')}`);
  }
  await waitFor(Q1, (s) => s.phase === 'end', 'fin du blind test');
  check((await emit(Q1, 'start')).ok, 'seconde manche de blind test');
  const g2 = await waitFor(Q1, (s) => s.phase === 'guess' && s.round === 2, 'manche 2', 0);
  check(!playedQ.includes(byPreview.get(g2.sound.track.preview).id), 'les sons déjà joués ne reviennent pas');
  roomQ.destroy();

  // ------------------------------------------------------------ Blind test progressif
  console.log('\nBlind test progressif : 2 joueurs, étapes accélérées');
  const roomP = makeRoom(Object.assign({}, CONFIG, {
    progressiveClips: [0.3, 0.6, 0.9],
    progressivePoints: [1000, 600, 200],
    stageGap: 0.4,
    songCountMin: 2,
  }));
  const [R1, R2] = ['Quentin', 'Rose'].map((n) => client(n, roomP));
  await join(R1, R1.label);
  await join(R2, R2.label);
  await emit(R1, 'settings', { mode: 'progressive', source: '80s', songCount: 2 });
  check((await emit(R1, 'start')).ok, 'progressif lancé (années 80)');
  const s0 = await waitFor(R1, (s) => s.phase === 'guess' && s.sound.index === 1, 'étape 1', 0);
  const trackP = byPreview.get(s0.sound.track.preview);
  check(s0.stage.index === 0 && s0.stage.clip === 0.3 && s0.stage.points === 1000, 'étape 1 : extrait court, 1000 points en jeu');
  check((await emit(R1, 'answer', { text: trackP.title })).gained.title === 500, "titre à l'étape 1 : 500 (moitié de 1000)");
  await waitFor(R1, (s) => s.stage && s.stage.index === 1, 'étape 2');
  check((await emit(R2, 'answer', { text: trackP.artist })).gained.artist === 300, "artiste à l'étape 2 : 300 (moitié de 600)");
  await waitFor(R1, (s) => s.stage && s.stage.index === 2, 'étape 3');
  check((await emit(R1, 'answer', { text: trackP.artist })).gained.artist === 100, "artiste à l'étape 3 : 100");
  await sleep(320);
  await emit(R2, 'answer', { text: trackP.title });
  const rp = await waitFor(R1, (s) => s.phase === 'reveal' && s.sound.index === 1, 'reveal progressif');
  check(rp.reveal.gains[R1.id] === 600 && rp.reveal.gains[R2.id] === 400, 'gains : Quentin 600, Rose 400');
  const t2 = Date.now();
  await waitFor(R1, (s) => s.phase === 'guess' && s.sound.index === 2, 'son 2', 0);
  await waitFor(R1, (s) => s.phase === 'reveal' && s.sound.index === 2, 'reveal 2');
  check(Date.now() - t2 >= 2400, 'sans réponse : toutes les étapes passent avant le reveal');
  roomP.destroy();

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
