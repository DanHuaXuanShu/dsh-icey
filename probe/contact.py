"""把一段连拍的序列帧拼成 contact sheet，方便一眼看出什么时候在打。"""
import glob
import os
import sys

from PIL import Image, ImageDraw

src = sys.argv[1] if len(sys.argv) > 1 else r"D:\dsh\ICEY插件\shots\combat2"
files = sorted(glob.glob(os.path.join(src, "f_*.png")))
if not files:
    raise SystemExit("no frames in " + src)

cols = 5
tw, th = 320, 186
rows = (len(files) + cols - 1) // cols
sheet = Image.new("RGB", (cols * tw, rows * th), (10, 10, 10))
draw = ImageDraw.Draw(sheet)

for i, f in enumerate(files):
    im = Image.open(f).convert("RGB").resize((tw, th), Image.LANCZOS)
    x, y = (i % cols) * tw, (i // cols) * th
    sheet.paste(im, (x, y))
    draw.text((x + 6, y + 4), f"{i:03d}", fill=(255, 255, 0))

out = os.path.join(src, "contact.png")
sheet.save(out)
print("wrote", out, sheet.size, "frames:", len(files))
