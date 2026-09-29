# BlindYourFriends

Blind test multijoueur entre potes : chacun choisit des sons en secret, puis tout le monde devine qui les a mis.

La partie tourne en **pair-à-pair** : l'hôte fait tourner le jeu sur sa machine et chaque ami s'y connecte directement (WebRTC). Aucun serveur de jeu à héberger.

## Jouer

- **Page du jeu** : https://imdarling-bit.github.io/BlindYourFriends/
- **Lanceur Windows** : https://github.com/ImDarling-bit/BlindYourFriends/releases/latest (fichier `BlindYourFriends-Setup-x.y.z.exe`)

### L'hôte

Installer le lanceur (double-clic, il s'installe sans droits administrateur et se lance), choisir un pseudo, **Créer une partie**, envoyer le lien d'invitation. Le lanceur se met à jour tout seul.

Sans certificat de signature, Windows SmartScreen affiche un avertissement au premier lancement : « Informations complémentaires », puis « Exécuter quand même ».

On peut aussi héberger depuis la page du jeu dans un navigateur, à condition de garder l'onglet au premier plan (le navigateur ralentit les minuteurs des onglets en arrière-plan).

### Les amis

Ouvrir le lien d'invitation (ou la page du jeu, puis taper le code à 4 lettres). Rien à installer, ça marche sur téléphone comme sur PC. Si l'hôte ferme le lanceur, la partie s'arrête pour tout le monde.

## Déroulement

1. **Préparation** : chaque joueur choisit le nombre de sons fixé par l'hôte (1 à 5), 30 s par son.
2. **Écoute** (30 s par son) : on vote pour la personne qui a mis le son. Le propriétaire ne vote pas.
3. **Délibération** (30 s de plus) : seulement si les votes ne désignent pas tous la même personne. On débat et on peut changer son vote. Si tout le monde tombe d'accord, reveal immédiat.
4. **Reveal** : qui l'a mis, qui a voté quoi, les points gagnés.

Points : +100 par bonne réponse, +50 pour le propriétaire par joueur piégé. Les scores se cumulent d'une manche à l'autre. Les règles sont aussi dans le jeu (bouton `?` en bas à droite) et le volume se règle dans la barre du haut.

## Réglages (`public/config.js`)

| Champ          | Rôle                                                                  |
|----------------|-----------------------------------------------------------------------|
| `publicUrl`    | Adresse publique de la page, pour les liens d'invitation              |
| `times`        | Durées : `pickTime` (par son), `guessTime`, `deliberateTime`, `revealTime` |
| `peerServer`   | Serveur de mise en relation PeerJS (vide : serveur public gratuit)    |
| `iceServers`   | Serveurs STUN/TURN                                                    |

### Connexions difficiles (4G, réseaux d'entreprise)

Environ 10 à 20 % des connexions directes échouent derrière certains réseaux mobiles ou pare-feux. Pour ces cas, ajouter un relais TURN dans `iceServers` (offres gratuites limitées chez Metered ou Cloudflare) : le jeu échange très peu de données.

## Comment ça marche

- `public/game.js` : le moteur (machine à états, scores), exécuté chez l'hôte.
- `public/net.js` : le transport WebRTC via PeerJS. L'id PeerJS de l'hôte est `byf-<CODE>` ; le serveur public PeerJS sert uniquement à la mise en relation, puis tout passe en direct.
- `public/deezer.js` : recherche Deezer depuis le navigateur (JSONP). L'hôte résout lui-même chaque son choisi à partir de son id : un joueur ne peut pas imposer une URL.
- Chaque joueur ne reçoit que son propre état : personne ne voit les choix des autres, ni qui a voté pendant l'écoute. L'hôte, lui, a techniquement tout sur sa machine.
- `server.js` : sert les fichiers de `public/` (pour le lanceur et le Wi-Fi local).
- `electron/main.js` : le lanceur. Il lève le blocage de la lecture auto, empêche les minuteurs de ralentir quand la fenêtre est réduite et se met à jour depuis les releases GitHub.

## Publication automatique

- **Page du jeu** : chaque modification de `public/` poussée sur `main` est publiée sur GitHub Pages (`.github/workflows/pages.yml`).
- **Nouvelle version du lanceur** :

  ```bash
  npm version patch        # 1.0.0 -> 1.0.1, crée le commit et le tag v1.0.1
  git push --follow-tags
  ```

  GitHub lance la partie simulée, construit l'installeur et le publie dans les releases (`.github/workflows/release.yml`). Les lanceurs installés le téléchargent en arrière-plan et l'installent à leur prochaine fermeture.

## Développement

```bash
npm install
npm run desktop     # lanceur en mode développement
npm start           # la page seule, dans le navigateur : http://localhost:3000
npm run simulate    # partie simulée à 3 joueurs sur le moteur (vrais sons Deezer)
npm run dist        # construit l'installeur en local dans dist/
```

Dans un navigateur classique, l'hôte doit garder l'onglet de la partie ouvert au premier plan ou en lecture, sinon le navigateur peut ralentir les minuteurs. Le lanceur n'a pas ce problème.
