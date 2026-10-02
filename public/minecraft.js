// Rendu d'un skin Minecraft en photo de profil (buste vu de trois quarts).
// Portage en JavaScript de render.py du projet minecraft-skin-render de jensjeflensje
// (https://github.com/jensjeflensje/minecraft-skin-render, licence MIT) : mêmes découpes du skin,
// mêmes tailles et positions, sur un canvas au lieu de Pillow.
(function () {
  'use strict';

  const CANVAS = 1000;
  const PIXEL = Math.round(CANVAS / 20); // pixels du skin pour la tête
  const BODY_PIXEL = Math.round(CANVAS / 35); // pixels du skin pour le corps
  const BACKGROUND = '#3a1d5c';
  const OUTPUT = 160; // taille de l'avatar final, en pixels

  // Zones du skin (x0, y0, x1, y1), comme dans render.py.
  const HEAD_FRONT = [8, 8, 15, 16];
  const HEAD_FRONT_TOP = [40, 8, 47, 16];
  const HEAD_LEFT = [4, 8, 8, 16];
  const HEAD_LEFT_TOP = [35, 8, 40, 16];
  const NECK = [20, 18, 28, 20];
  const BODY = [20, 20, 28, 32];
  const BODY_TOP = [20, 36, 28, 48];
  const armRight = (a) => [40 + a, 20, 40 + 2 * a, 32];
  const armRightTop = (a) => [40 + a, 36, 40 + 2 * a, 48];
  const armLeft = (a) => [52 - 5 * a, 52, 52 - 4 * a, 64];
  const armLeftTop = (a) => [60 - a, 52, 64, 64];

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous'; // nécessaire pour relire les pixels du skin
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Skin introuvable.'));
      img.src = url;
    });
  }

  // Skin officiel et modèle (bras fins "slim" ou larges) d'un pseudo Minecraft.
  async function fetchSkin(username) {
    const name = String(username || '').trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) throw new Error('Pseudo Minecraft invalide (3 à 16 lettres, chiffres ou _).');
    try {
      const res = await fetch(`https://playerdb.co/api/player/minecraft/${encodeURIComponent(name)}`);
      const data = await res.json();
      if (data && data.code === 'minecraft.invalid_username') throw Object.assign(new Error('Aucun joueur Minecraft avec ce pseudo.'), { final: true });
      const player = data && data.success && data.data && data.data.player;
      if (player && player.skin_texture) {
        let slim = false;
        const prop = (player.properties || []).find((x) => x.name === 'textures');
        if (prop) {
          const textures = JSON.parse(atob(prop.value)).textures || {};
          slim = !!(textures.SKIN && textures.SKIN.metadata && textures.SKIN.metadata.model === 'slim');
        }
        return { img: await loadImage(player.skin_texture.replace(/^http:/, 'https:')), slim, name: player.username || name };
      }
    } catch (err) {
      if (err.final) throw err;
      // playerdb indisponible : on passe au service de secours.
    }
    return { img: await loadImage(`https://mc-heads.net/skin/${encodeURIComponent(name)}`), slim: null, name };
  }

  function pixels(img) {
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return ctx;
  }

  // Modèle inconnu : un bras "slim" laisse transparente la 4e colonne du bras droit.
  function looksSlim(skinCtx) {
    const data = skinCtx.getImageData(54, 20, 2, 12).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return false;
    return true;
  }

  // Calque supérieur entièrement noir et opaque : vieux skins où il n'est pas utilisé.
  // Minecraft l'ignore, on fait pareil (sinon la tête de ces joueurs serait toute noire).
  function unusedOverlay(ctx, w, h) {
    const data = ctx.getImageData(0, 0, w, h).data;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] !== 255 || data[i] || data[i + 1] || data[i + 2]) return false;
    }
    return true;
  }

  // Découpe une zone du skin, avec retouches éventuelles (pixels effacés, assombrissement).
  // Pour un calque supérieur (overlay), renvoie null s'il n'est pas utilisé.
  function part(skin, box, { clear = [], shade = 0, overlay = false } = {}) {
    const [x0, y0, x1, y1] = box;
    const c = document.createElement('canvas');
    c.width = x1 - x0;
    c.height = y1 - y0;
    const ctx = c.getContext('2d');
    ctx.drawImage(skin, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
    if (overlay && unusedOverlay(ctx, c.width, c.height)) return null;
    for (const [x, y] of clear) ctx.clearRect(x, y, 1, 1);
    if (shade) {
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = `rgba(0, 0, 0, ${shade / 255})`;
      ctx.fillRect(0, 0, c.width, c.height);
    }
    return c;
  }

  const sizeOf = (box, px) => [(box[2] - box[0]) * px, (box[3] - box[1]) * px];

  function draw(ctx, src, [x, y], [w, h]) {
    if (src) ctx.drawImage(src, x, y, w, h);
  }

  /**
   * Rend le buste d'un skin Minecraft (64x64, ou ancien format 64x32).
   * Renvoie un canvas CANVAS x CANVAS.
   */
  function renderSkin(skinImg, slim) {
    if (skinImg.width !== 64 || (skinImg.height !== 64 && skinImg.height !== 32)) {
      throw new Error('Format de skin non pris en charge.');
    }
    const legacy = skinImg.height === 32; // pas de calques ni de bras gauche séparé
    const skinCtx = pixels(skinImg);
    const arm = (slim === null ? looksSlim(skinCtx) : slim) ? 3 : 4;

    const canvas = document.createElement('canvas');
    canvas.width = CANVAS;
    canvas.height = CANVAS;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false; // pixels nets, comme Image.NONE
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, CANVAS, CANVAS);

    // Tête : face avant, puis côté gauche assombri.
    const headFrontSize = sizeOf(HEAD_FRONT, PIXEL);
    const headFrontLoc = [Math.round(CANVAS / 2 - 2 * PIXEL), 200];
    draw(ctx, part(skinImg, HEAD_FRONT), headFrontLoc, headFrontSize);
    draw(ctx, part(skinImg, HEAD_FRONT_TOP, { overlay: true }), headFrontLoc, headFrontSize);

    const headLeftSize = sizeOf(HEAD_LEFT, PIXEL);
    const headLeftLoc = [headFrontLoc[0] - 3 * PIXEL, headFrontLoc[1]];
    draw(ctx, part(skinImg, HEAD_LEFT, { shade: 65 }), headLeftLoc, headLeftSize);
    draw(ctx, part(skinImg, HEAD_LEFT_TOP, { overlay: true }), headLeftLoc, headLeftSize);

    // Corps.
    const bodySize = sizeOf(BODY, BODY_PIXEL);
    const bodyLoc = [headFrontLoc[0] - BODY_PIXEL, headFrontLoc[1] + headFrontSize[1] + 2 * BODY_PIXEL];
    draw(ctx, part(skinImg, BODY), bodyLoc, bodySize);
    if (!legacy) draw(ctx, part(skinImg, BODY_TOP, { overlay: true }), bodyLoc, bodySize);

    // Cou.
    const neckSize = sizeOf(NECK, BODY_PIXEL);
    draw(ctx, part(skinImg, NECK, { clear: [[0, 0], [7, 0]] }), [bodyLoc[0], bodyLoc[1] - 2 * BODY_PIXEL], neckSize);

    // Bras droit (à droite de l'image).
    const rightBox = armRight(arm);
    const armSize = sizeOf(rightBox, BODY_PIXEL);
    const rightLoc = [bodyLoc[0] + bodySize[0], bodyLoc[1] - BODY_PIXEL];
    draw(ctx, part(skinImg, rightBox, { clear: [[arm - 1, 0], [arm - 2, 0]] }), rightLoc, armSize);
    if (!legacy) draw(ctx, part(skinImg, armRightTop(arm), { overlay: true }), rightLoc, armSize);

    // Bras gauche (l'ancien format n'en a pas : on réutilise le droit).
    const leftLoc = [bodyLoc[0] - arm * BODY_PIXEL, bodyLoc[1] - BODY_PIXEL];
    const leftBox = legacy ? rightBox : armLeft(arm);
    draw(ctx, part(skinImg, leftBox, { clear: [[0, 0], [1, 0]] }), leftLoc, armSize);
    if (!legacy) draw(ctx, part(skinImg, armLeftTop(arm), { overlay: true }), leftLoc, armSize);

    return canvas;
  }

  // Cadre carré centré sur le buste, réduit à la taille d'un avatar.
  function toAvatar(render) {
    const out = document.createElement('canvas');
    out.width = OUTPUT;
    out.height = OUTPUT;
    const ctx = out.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // Marge au-dessus de la tête pour qu'elle ne soit pas coupée dans un avatar rond.
    const crop = 800;
    ctx.drawImage(render, (CANVAS - crop) / 2, 100, crop, crop, 0, 0, OUTPUT, OUTPUT);
    return out.toDataURL('image/png');
  }

  /** Photo de profil (data URL PNG) à partir d'un pseudo Minecraft. */
  async function avatarFor(username) {
    const { img, slim, name } = await fetchSkin(username);
    return { data: toAvatar(renderSkin(img, slim)), name };
  }

  window.BYFMinecraft = { avatarFor };
})();
