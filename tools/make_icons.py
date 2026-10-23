"""Render PostPing icons (16/32/48/128) with Pillow using supersampling.

Design on a 128-unit grid: indigo->blue rounded square, a white "post card"
and an orange ping badge with a soft pulse ring in the top-right corner.
"""
import sys
from PIL import Image, ImageDraw

OUT = sys.argv[1]
SS = 8  # supersampling factor per output pixel

TOP = (99, 102, 241)      # #6366F1
BOTTOM = (29, 78, 216)    # #1D4ED8
CARD = (255, 255, 255)
SOFT = (199, 210, 254)    # #C7D2FE
SOFTER = (165, 180, 252)  # #A5B4FC
PING = (249, 115, 22)     # #F97316


def gradient(size):
    g = Image.linear_gradient("L").resize((size, size))
    a = Image.new("RGB", (size, size), TOP)
    b = Image.new("RGB", (size, size), BOTTOM)
    return Image.composite(b, a, g)


def render(px, simple=False):
    S = px * SS
    u = S / 128.0  # one design unit

    def r(*v):
        return [x * u for x in v]

    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    bg = gradient(S).convert("RGBA")
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle(r(0, 0, 128, 128), radius=28 * u, fill=255)
    img.paste(bg, (0, 0), mask)

    d = ImageDraw.Draw(img, "RGBA")

    def cut(cx, cy, rad):
        m = Image.new("L", (S, S), 0)
        ImageDraw.Draw(m).ellipse(r(cx - rad, cy - rad, cx + rad, cy + rad), fill=255)
        img.paste(bg, (0, 0), m)

    if simple:
        # 16px: bigger, bolder shapes so they survive downscaling
        d.rounded_rectangle(r(14, 38, 94, 112), radius=14 * u, fill=CARD)
        d.rounded_rectangle(r(28, 60, 80, 72), radius=6 * u, fill=SOFTER)
        d.rounded_rectangle(r(28, 84, 66, 96), radius=6 * u, fill=SOFTER)
        cut(94, 34, 28)
        d.ellipse(r(74, 14, 114, 54), fill=PING)
    else:
        cx, cy = 94, 36
        # pulse rings (drawn first so the card covers them)
        for rad, a in ((30, 70), (40, 35)):
            d.ellipse(r(cx - rad, cy - rad, cx + rad, cy + rad), outline=(255, 255, 255, a), width=round(3 * u))
        # post card
        d.rounded_rectangle(r(18, 44, 92, 110), radius=12 * u, fill=CARD)
        d.ellipse(r(28, 54, 46, 72), fill=SOFTER)                 # avatar
        d.rounded_rectangle(r(52, 56, 70, 62), radius=3 * u, fill=SOFT)
        d.rounded_rectangle(r(52, 66, 64, 70), radius=2 * u, fill=SOFT)
        d.rounded_rectangle(r(28, 82, 82, 88), radius=3 * u, fill=SOFT)
        d.rounded_rectangle(r(28, 95, 68, 101), radius=3 * u, fill=SOFT)
        # gap + ping badge
        cut(cx, cy, 21)
        d = ImageDraw.Draw(img, "RGBA")
        d.ellipse(r(cx - 15, cy - 15, cx + 15, cy + 15), fill=PING)
        d.ellipse(r(cx - 6, cy - 9, cx + 1, cy - 2), fill=(255, 255, 255, 90))

    img.putalpha(mask)  # clip everything (pulse rings) to the rounded square
    return img.resize((px, px), Image.LANCZOS)


for size in (16, 32, 48, 128):
    render(size, simple=(size <= 16)).save(f"{OUT}/icon{size}.png")
render(512).save(f"{OUT}/icon512_preview.png")
print("done")
