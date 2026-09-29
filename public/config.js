// Réglages de BlindYourFriends. Les durées sont celles de l'hôte : c'est lui qui fait tourner la partie.
window.BYF_CONFIG = {
  // Adresse publique de cette page (publiée par GitHub Pages), utilisée pour les liens d'invitation.
  // Vide : le lanceur propose son adresse sur le réseau local, sinon l'adresse de la page actuelle.
  publicUrl: 'https://imdarling-bit.github.io/BlindYourFriends/',

  // Durées en secondes. pickTime est donné par son à choisir.
  times: {
    pickTime: 30,
    guessTime: 30,
    deliberateTime: 30,
    revealTime: 7,
  },

  // Serveur de mise en relation PeerJS. Vide : serveur public gratuit de PeerJS (0.peerjs.com).
  // Exemple auto-hébergé : { host: 'peer.mondomaine.fr', port: 443, path: '/', secure: true }
  peerServer: null,

  // Serveurs STUN/TURN pour traverser les box et les réseaux mobiles.
  // Un relais TURN (Metered, Cloudflare...) aide les ~10-20 % de connexions qui échouent sinon.
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    // { urls: 'turn:TURN_HOST:443?transport=tcp', username: 'USER', credential: 'PASS' },
  ],
};
