// Catalogue BlindYourFriends : modes de jeu, thèmes, sources de musique
// et vérification des réponses tapées. Partagé par la page, le moteur et les tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BYFCatalog = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MODES = [
    {
      id: 'classic',
      label: 'Blind test',
      short: 'Le jeu choisit les sons : trouve le titre et l\'artiste.',
    },
    {
      id: 'byf-theme',
      label: 'BlindYourFriends à thème',
      short: 'Chacun choisit des sons sur un thème imposé. Hors thème : pénalité.',
    },
    {
      id: 'byf',
      label: 'BlindYourFriends',
      short: 'Chacun choisit des sons en secret : devinez qui a mis quoi.',
    },
    {
      id: 'progressive',
      label: 'Blind test progressif',
      short: '1 s, 2 s, 4 s... 30 s : plus tu trouves tôt, plus tu marques.',
    },
  ];
  const DEFAULT_MODE = 'byf';
  const QUIZ_MODES = ['classic', 'progressive']; // le jeu choisit les sons, on tape les réponses
  const PICK_MODES = ['byf', 'byf-theme']; // les joueurs choisissent les sons

  const THEMES = [
    { id: 'rap', label: 'Rap' },
    { id: 'retro', label: 'Rétro (avant 1990)' },
    { id: '2000s', label: 'Années 2000' },
    { id: 'rock', label: 'Rock' },
    { id: 'electro', label: 'Électro / Dance' },
    { id: 'fr', label: 'Chanson française' },
    { id: 'cartoon', label: 'Génériques de dessins animés et séries' },
    { id: 'movie', label: 'Musique de film' },
    { id: 'guilty', label: 'Plaisir coupable' },
    { id: 'childhood', label: 'Une chanson de ton enfance' },
    { id: 'love', label: "Chanson d'amour" },
    { id: 'summer', label: "Tube de l'été" },
  ];

  // Sources du blind test : classements Deezer par style et playlists éditoriales Deezer.
  const SOURCES = [
    { id: 'hits', label: 'Hits du moment', chart: 0 },
    { id: 'rap', label: 'Rap / Hip-hop', chart: 116 },
    { id: 'pop', label: 'Pop', chart: 132 },
    { id: 'rock', label: 'Rock', chart: 152 },
    { id: 'dance', label: 'Dance', chart: 113 },
    { id: 'rnb', label: 'R&B', chart: 165 },
    { id: 'fr', label: 'Chanson française', chart: 52 },
    { id: 'films', label: 'Films et jeux vidéo', chart: 173 },
    { id: '80s', label: 'Années 80', playlist: 867825522 },
    { id: '90s', label: 'Années 90', playlist: 1251125011 },
    { id: '2000s', label: 'Années 2000', playlist: 11837091441 },
    { id: '2010s', label: 'Années 2010', playlist: 2051712324 },
    { id: 'vf', label: 'Variété française culte', playlist: 7752025662 },
    { id: 'cartoons', label: 'Génériques de dessins animés', playlist: 9976576142 },
  ];
  const DEFAULT_SOURCE = 'hits';

  const byId = (list, id) => list.find((x) => x.id === id) || null;

  // ---------------------------------------------------------------- réponses tapées

  const ARTICLES = /^(the|le|la|les|l|un|une|des) /;
  const FEAT = /\s(feat|ft|featuring)\.?\s.*$/i;

  // Minuscules, sans accents ni ponctuation. S'applique aussi bien à la réponse tapée
  // qu'aux réponses attendues.
  function normalize(text) {
    return String(text || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/&/g, ' et ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  // Comparaison sans espaces ("lamour" = "l'amour").
  const squash = (text) => text.replace(/ /g, '');

  // Une réponse attendue, avec et sans son article ("the weeknd" et "weeknd").
  function forms(text) {
    const n = normalize(text);
    return [squash(n), squash(n.replace(ARTICLES, ''))];
  }

  function unique(list) {
    return [...new Set(list.filter((v) => v.length >= 2))];
  }

  // Titre : complet, sans la parenthèse ni le "feat.", ou une de ses parties
  // ("Goldorak : La légende d'Actarus" -> "goldorak"). Le titre avec sa parenthèse
  // est accepté aussi ("Sweet Dreams (Are Made of This)").
  function titleVariants(title) {
    const full = String(title || '');
    const raw = full.replace(/\(.*?\)|\[.*?\]/g, ' ').replace(FEAT, ' ');
    const parts = raw.split(/\s[-–]\s|:|\//);
    return unique([raw, full.replace(/[()[\]]/g, ' '), ...parts].flatMap(forms));
  }

  // Artiste : nom complet, ou un des artistes d'un duo ("Stromae & Pomme" -> "stromae").
  function artistVariants(artist) {
    const raw = String(artist || '');
    const parts = raw.split(/,|&|\/|\s(?:x|et|and|feat\.?|ft\.?|featuring|vs\.?)\s/i);
    return unique([raw, ...parts].flatMap(forms));
  }

  // Distance d'édition où deux lettres inversées ("pnuk") ne comptent que pour une faute.
  function distance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    const d = [];
    for (let i = 0; i <= a.length; i++) d.push([i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      let best = Infinity;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2][j - 2] + 1);
        d[i][j] = v;
        if (v < best) best = v;
      }
      if (best > max) return max + 1;
    }
    return d[a.length][b.length];
  }

  // Une faute de frappe tolérée tous les 5 caractères, 3 au maximum ; rien sous 5 caractères.
  function close(guess, expected) {
    if (guess === expected) return true;
    const max = Math.min(3, Math.floor(expected.length / 5));
    return max > 0 && distance(guess, expected, max) <= max;
  }

  /**
   * Compare une réponse tapée au titre et à l'artiste d'un son.
   * Renvoie { title, artist } : ce que la réponse a trouvé.
   * Accepte aussi "artiste titre" ou "titre artiste" d'un coup.
   */
  function matchAnswer(guess, track) {
    const g = squash(normalize(guess));
    const result = { title: false, artist: false };
    if (g.length < 2) return result;
    const titles = titleVariants(track.title);
    const artists = artistVariants(track.artist);
    const isTitle = (x) => titles.some((t) => close(x, t));
    const isArtist = (x) => artists.some((a) => close(x, a));
    result.title = isTitle(g);
    result.artist = isArtist(g);
    // Réponse en deux morceaux : chaque morceau doit valoir seul son titre ou son artiste.
    // Tenté même si la réponse entière ressemble déjà à l'un des deux : avec la tolérance,
    // un titre long peut absorber un artiste court ("u2 with or without you").
    for (let i = 2; i <= g.length - 2 && !(result.title && result.artist); i++) {
      const head = g.slice(0, i);
      const tail = g.slice(i);
      if ((isArtist(head) && isTitle(tail)) || (isTitle(head) && isArtist(tail))) {
        result.title = true;
        result.artist = true;
      }
    }
    return result;
  }

  return {
    MODES,
    DEFAULT_MODE,
    QUIZ_MODES,
    PICK_MODES,
    THEMES,
    SOURCES,
    DEFAULT_SOURCE,
    mode: (id) => byId(MODES, id),
    theme: (id) => byId(THEMES, id),
    source: (id) => byId(SOURCES, id),
    isQuiz: (mode) => QUIZ_MODES.includes(mode),
    matchAnswer,
    normalize,
  };
});
