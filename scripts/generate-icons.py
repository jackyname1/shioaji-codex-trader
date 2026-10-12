"""Render the multicolor candle symbol on Windows' 48px icon grid."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageOps

ROOT = Path(__file__).resolve().parents[1] / "src/desktop/assets"


def glyph(draw, scale, small=False):
    # Three rising candles: one trading metaphor, no letters, rings, axes or badges.
    for x, top, height, wick_top, wick_bottom, color in [
        (9, 27, 9, 23, 39, "#f5c777"),
        (20, 21, 11, 16, 36, "#79c7f4"),
        (31, 13, 14, 8, 31, "#c3a4ff"),
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
    # Diagonal navy-to-black tile, with a light edge that survives dark taskbars.
    ramp=bytes(round(255*n/(2*(side-1))) for n in range(2*side-1))
    diagonal=Image.frombytes("L",(side,side),b"".join(ramp[y:y+side] for y in range(side)))
    background=ImageOps.colorize(diagonal,"#172435","#0c1016").convert("RGBA")
    image.paste(background,mask=mask)
    painter=ImageDraw.Draw(image)
    painter.rounded_rectangle((2*scale,2*scale,46*scale,46*scale),radius=11*scale,
                              outline="#3b4f6b",width=max(1,round(.6*scale)))
    glyph(painter,scale,small=size<=24)
    if status:
        color={"ready":"#61d8b5","active":"#79c7f4","paused":"#f5c777","offline":"#a1a0b6"}[status]
        painter.ellipse((35*scale,32*scale,47*scale,44*scale),fill="#13131e")
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
