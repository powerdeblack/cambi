"""Monta imagens para posts (JPG 1600x900) a partir dos prints do app.

Uso: python3 scripts/post-images.py <pasta-dos-prints> <pasta-de-saida>
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

SRC, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)

W, H = 1600, 900
BG = (15, 42, 68)
GREEN = (22, 163, 74)
WHITE = (255, 255, 255)
MUTED = (184, 200, 216)
FONT_DIR = "/usr/share/fonts/truetype/dejavu"


def font(size, bold=False):
    name = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
    try:
        return ImageFont.truetype(os.path.join(FONT_DIR, name), size)
    except OSError:
        return ImageFont.load_default(size)


def phone(path, height):
    """Print com cantos arredondados, na altura pedida."""
    im = Image.open(path).convert("RGB")
    w = round(im.width * height / im.height)
    im = im.resize((w, height), Image.LANCZOS)
    mask = Image.new("L", im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, height - 1), radius=28, fill=255)
    return im, mask


def logo(draw, x, y, size):
    f = font(size, bold=True)
    draw.text((x, y), "camb", font=f, fill=WHITE)
    draw.text((x + draw.textlength("camb", font=f), y), "I", font=f, fill=GREEN)


def wrap(draw, text, f, width):
    lines, cur = [], ""
    for word in text.split():
        test = (cur + " " + word).strip()
        if draw.textlength(test, font=f) <= width:
            cur = test
        else:
            lines.append(cur)
            cur = word
    lines.append(cur)
    return lines


SHOTS = [
    ("08-inicio.png", "1-home.jpg", "A real Solana account, no seed phrase",
     "Live USD/BRL quote and a bank-style home screen. Every balance is on Solana devnet."),
    ("04-troca-comprovante.png", "2-swap.jpg", "Swap R$100 to dollars, on-chain",
     "The receipt links to the transaction and shows where every cent of the fee goes."),
    ("06-pix-comprovante.png", "3-pix.jpg", "The other side of the trade: Pix",
     "Send reais by Pix, to a US bank account or to a USDC wallet. Recorded on Solana."),
    ("07-atividade.png", "4-activity.jpg", "Every action is verifiable",
     "Faucet, swap, deposit and Pix, each with a link to the blockchain."),
]

for src, dst, title, sub in SHOTS:
    path = os.path.join(SRC, src)
    if not os.path.exists(path):
        continue
    canvas = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(canvas)
    im, mask = phone(path, 820)
    px = W - im.width - 140
    canvas.paste(im, (px, 40), mask)
    left, width = 110, px - 110 - 90
    logo(d, left, 110, 64)
    ft, fs = font(54, bold=True), font(32)
    y = 260
    for line in wrap(d, title, ft, width):
        d.text((left, y), line, font=ft, fill=WHITE)
        y += 68
    y += 24
    for line in wrap(d, sub, fs, width):
        d.text((left, y), line, font=fs, fill=MUTED)
        y += 46
    d.text((left, H - 110), "powerdeblack.github.io/cambi  ·  Solana devnet", font=font(26), fill=MUTED)
    canvas.save(os.path.join(OUT, dst), "JPEG", quality=88, optimize=True)

# As 4 telas lado a lado, numa imagem só.
canvas = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(canvas)
logo(d, 60, 30, 48)
d.text((260, 44), "BRL ↔ USD on Solana, owned by its users", font=font(30), fill=MUTED)
shots = [os.path.join(SRC, s[0]) for s in SHOTS if os.path.exists(os.path.join(SRC, s[0]))]
if shots:
    ims = [phone(p, 770) for p in shots]
    gap = 30
    total = sum(im.width for im, _ in ims) + gap * (len(ims) - 1)
    x = (W - total) // 2
    for im, mask in ims:
        canvas.paste(im, (x, 105), mask)
        x += im.width + gap
    canvas.save(os.path.join(OUT, "0-all.jpg"), "JPEG", quality=88, optimize=True)

print("\n".join(sorted(os.listdir(OUT))))
