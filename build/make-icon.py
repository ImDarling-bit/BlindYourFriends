"""Génère l'icône de BlindYourFriends : un vinyle au dégradé rose-violet avec un « ? » au centre.

    python build/make-icon.py

Produit build/icon.png (lanceur), build/icon.ico (Windows) et public/favicon.png, public/apple-touch-icon.png.
"""
import math
import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SIZE = 1024
CENTER = SIZE / 2
PINK = (255, 61, 139)
MAGENTA = (194, 56, 230)
VIOLET = (138, 63, 252)
NIGHT = (18, 8, 31)
FONT = r"C:\Windows\Fonts\seguibl.ttf"


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient(size):
    """Dégradé diagonal rose -> magenta -> violet, comme dans le jeu."""
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = lerp(PINK, MAGENTA, t * 2) if t < 0.5 else lerp(MAGENTA, VIOLET, (t - 0.5) * 2)
    return img


def circle_box(r):
    return (CENTER - r, CENTER - r, CENTER + r, CENTER + r)


def draw_icon():
    disc_r = 488
    icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    # Disque en dégradé.
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).ellipse(circle_box(disc_r), fill=255)
    icon.paste(gradient(SIZE), (0, 0), mask)

    overlay = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    # Sillons du vinyle.
    for r in (440, 395, 350, 305, 262):
        d.ellipse(circle_box(r), outline=(18, 8, 31, 70), width=7)
    # Reflet.
    d.arc(circle_box(452), start=200, end=255, fill=(255, 255, 255, 90), width=22)
    d.arc(circle_box(452), start=20, end=50, fill=(255, 255, 255, 45), width=16)
    # Étiquette centrale.
    d.ellipse(circle_box(212), fill=NIGHT + (255,))
    d.ellipse(circle_box(212), outline=(255, 255, 255, 40), width=6)
    icon = Image.alpha_composite(icon, overlay)

    # Point d'interrogation.
    d = ImageDraw.Draw(icon)
    font = ImageFont.truetype(FONT, 330)
    box = d.textbbox((0, 0), "?", font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    d.text((CENTER - w / 2 - box[0], CENTER - h / 2 - box[1]), "?", font=font, fill=(255, 255, 255, 255))
    return icon


def main():
    icon = draw_icon()
    os.makedirs(os.path.join(ROOT, "build"), exist_ok=True)
    icon.resize((512, 512), Image.LANCZOS).save(os.path.join(ROOT, "build", "icon.png"))
    icon.save(
        os.path.join(ROOT, "build", "icon.ico"),
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    icon.resize((64, 64), Image.LANCZOS).save(os.path.join(ROOT, "public", "favicon.png"))
    # Fond plein pour l'écran d'accueil iOS (pas de transparence).
    touch = Image.new("RGBA", (180, 180), NIGHT + (255,))
    small = icon.resize((164, 164), Image.LANCZOS)
    touch.alpha_composite(small, (8, 8))
    touch.convert("RGB").save(os.path.join(ROOT, "public", "apple-touch-icon.png"))
    print("Icônes générées.")


if __name__ == "__main__":
    main()
