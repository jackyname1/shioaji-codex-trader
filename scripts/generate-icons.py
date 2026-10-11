"""Render the project's own vector mark at each Windows icon size (Pillow only)."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1] / "src/desktop/assets"


def curve(points, segments):
    result = [points]
    for c1, c2, end in segments:
        start = result[-1]
        for n in range(1, 65):
            t = n / 64
            result.append(tuple((1-t)**3*start[a] + 3*(1-t)**2*t*c1[a] + 3*(1-t)*t*t*c2[a] + t**3*end[a] for a in (0, 1)))
    return result


def stroke(draw, points, color, width, scale):
    pts = [(x*scale, y*scale) for x, y in points]
    draw.line(pts, fill=color, width=round(width*scale), joint="curve")
    radius = width*scale/2
    for x, y in pts:
        draw.ellipse((x-radius, y-radius, x+radius, y+radius), fill=color)


def mark(draw, scale):
    """An orbital compass: two arcs and a four-point light, never a letter."""
    left = curve((183, 104), [((94, 140), (74, 253), (129, 331)), ((153, 365), (183, 388), (218, 400))])
    right = curve((329, 400), [((420, 363), (441, 250), (385, 173)), ((362, 138), (333, 115), (294, 103))])
    stroke(draw, left, "#7e9cb5", 18, scale)
    stroke(draw, right, "#63dfc1", 18, scale)
    star = [(256, 141), (280, 228), (368, 252), (280, 276), (256, 363), (232, 276), (144, 252), (232, 228)]
    draw.polygon([(x*scale, y*scale) for x, y in star], fill="#eef8ff")
    draw.polygon([(x*scale, y*scale) for x, y in [(256, 141), (280, 228), (256, 252), (232, 228)]], fill="#75ecd0")


def app_icon(size):
    factor = 4
    side = size*factor
    scale = side/512
    image = Image.new("RGBA", (side, side))
    mask = Image.new("L", (side, side))
    ImageDraw.Draw(mask).rounded_rectangle(tuple(v*scale for v in (20, 20, 492, 492)), radius=112*scale, fill=255)
    background = Image.new("RGBA", (side, side))
    draw = ImageDraw.Draw(background)
    for y in range(side):
        t = y/(side-1)
        color = tuple(round(a*(1-t)+b*t) for a, b in zip((35, 59, 86), (12, 23, 40)))+(255,)
        draw.line((0, y, side, y), fill=color)
    image.paste(background, mask=mask)
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(tuple(v*scale for v in (22, 22, 490, 490)), radius=110*scale, outline="#3d566d", width=max(1, round(3*scale)))
    mark(draw, scale)
    return image.resize((size, size), Image.Resampling.LANCZOS)


def tray_icon(status):
    image = Image.new("RGBA", (256, 256))
    draw = ImageDraw.Draw(image)
    scale = 4
    draw.rounded_rectangle((12, 12, 244, 244), radius=60, fill="#142a40", outline="#66839a", width=4)
    mark(draw, .5)
    color = {"ready": "#66e0c0", "active": "#78b9ff", "paused": "#f3c37b", "offline": "#91a0b4"}[status]
    draw.ellipse((176, 28, 232, 84), fill="#142a40")
    draw.ellipse((180, 32, 228, 80), fill=color)
    return image.resize((64, 64), Image.Resampling.LANCZOS)


if __name__ == "__main__":
    ROOT.mkdir(parents=True, exist_ok=True)
    app_icon(512).save(ROOT / "app.png")
    app_icon(256).save(ROOT / "app.ico", sizes=[(s, s) for s in (16, 20, 24, 32, 40, 48, 64, 128, 256)],
        append_images=[app_icon(s) for s in (16, 20, 24, 32, 40, 48, 64, 128)])
    for status in ("ready", "active", "paused", "offline"):
        tray_icon(status).save(ROOT / f"tray-{status}.png")
    tray_icon("ready").save(ROOT / "tray.png")
