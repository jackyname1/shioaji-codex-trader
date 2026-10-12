"""Render our own candle glyph, using Windows' 48px icon grid and optical small-size adjustments."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1] / "src/desktop/assets"


def glyph(draw, scale, small=False):
    # Three rising candles: one trading metaphor, no letters, rings, axes or badges.
    for x, top, height, wick_top, wick_bottom, color in [
        (9, 27, 9, 23, 39, "#f5faff"),
        (20, 21, 11, 16, 36, "#c3efff"),
        (31, 13, 14, 8, 31, "#8af3d0"),
    ]:
        if not small:
            draw.rounded_rectangle(((x+2.8)*scale, wick_top*scale, (x+5.2)*scale, wick_bottom*scale),
                                   radius=1.2*scale, fill=color)
        draw.rounded_rectangle((x*scale, top*scale, (x+8)*scale, (top+height)*scale),
                               radius=1.6*scale, fill=color)


def icon(size, status=None):
    factor = 6
    side = size*factor
    scale = side/48
    image = Image.new("RGBA", (side, side))
    mask = Image.new("L", (side, side))
    ImageDraw.Draw(mask).rounded_rectangle((2*scale, 2*scale, 46*scale, 46*scale), radius=11*scale, fill=255)
    background = Image.new("RGBA", (side, side))
    painter = ImageDraw.Draw(background)
    for y in range(side):
        t=y/(side-1)
        color=tuple(round(a*(1-t)+b*t) for a,b in zip((46, 95, 228),(16, 42, 94)))+(255,)
        painter.line((0,y,side,y), fill=color)
    image.paste(background,mask=mask)
    painter=ImageDraw.Draw(image)
    glyph(painter,scale,small=size<=24)
    if status:
        color={"ready":"#60e9ba","active":"#72b8ff","paused":"#ffc77b","offline":"#a8b1c4"}[status]
        painter.ellipse((35*scale,32*scale,47*scale,44*scale),fill="#101c36")
        painter.ellipse((37*scale,34*scale,45*scale,42*scale),fill=color)
    return image.resize((size,size),Image.Resampling.LANCZOS)


if __name__ == "__main__":
    ROOT.mkdir(parents=True,exist_ok=True)
    icon(512).save(ROOT/"app.png")
    icon(256).save(ROOT/"app.ico",sizes=[(s,s) for s in (16,20,24,32,40,48,64,128,256)],
                   append_images=[icon(s) for s in (16,20,24,32,40,48,64,128)])
    for status in ("ready","active","paused","offline"):
        icon(64,status).save(ROOT/f"tray-{status}.png")
    icon(64,"ready").save(ROOT/"tray.png")
