"""生成 Hello Gitty 应用图标:圆角深色底 + 猫耳 + git 分支符号。"""
from PIL import Image, ImageDraw

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 圆角方形背景(上下渐变近似:分带绘制)
def rounded_rect(draw, box, r, fill):
    draw.rounded_rectangle(box, radius=r, fill=fill)

top = (99, 102, 241)    # indigo-500
bot = (139, 92, 246)    # violet-500
# 圆角矩形遮罩
mask = Image.new("L", (S, S), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([40, 40, S - 40, S - 40], radius=220, fill=255)
grad = Image.new("RGBA", (S, S), (0, 0, 0, 0))
gd = ImageDraw.Draw(grad)
for i in range(S):
    t = i / S
    c = tuple(int(top[j] + (bot[j] - top[j]) * t) for j in range(3)) + (255,)
    gd.line([(0, i), (S, i)], fill=c)
img = Image.composite(grad, img, mask)

d = ImageDraw.Draw(img)
WHITE = (255, 255, 255, 255)

# 猫耳:两个三角
ear = [(300, 300), (430, 170), (560, 300)]
d.polygon(ear, fill=WHITE)
ear2 = [(S - 300, 300), (S - 430, 170), (S - 560, 300)]
d.polygon(ear2, fill=WHITE)
# 内耳(底色,制造层次)
inner = [(330, 290), (430, 205), (530, 290)]
d.polygon(inner, fill=(255, 255, 255, 60))
inner2 = [(S - 330, 290), (S - 430, 205), (S - 530, 290)]
d.polygon(inner2, fill=(255, 255, 255, 60))

# 猫脸圆
d.ellipse([230, 300, S - 230, S - 230], fill=WHITE)

# git 分支符号:三条线 + 三个圆(深色,画在脸上)
INK = (30, 30, 60, 255)
cx = S / 2
# 中心竖线
d.line([(cx, 420), (cx, 660)], fill=INK, width=44)
# 左右分支线
d.line([(cx, 420), (cx - 150, 300)], fill=INK, width=44)
d.line([(cx, 420), (cx + 150, 300)], fill=INK, width=44)
# 三个圆点
r = 62
d.ellipse([cx - 150 - r, 300 - r, cx - 150 + r, 300 + r], fill=INK)
d.ellipse([cx + 150 - r, 300 - r, cx + 150 + r, 300 + r], fill=INK)
d.ellipse([cx - r, 660 - r, cx + r, 660 + r], fill=INK)

# 猫须
d.line([(330, 560), (170, 520)], fill=INK, width=16)
d.line([(330, 610), (170, 630)], fill=INK, width=16)
d.line([(S - 330, 560), (S - 170, 520)], fill=INK, width=16)
d.line([(S - 330, 610), (S - 170, 630)], fill=INK, width=16)

img.save("/Users/Bavoch/Coding/hello-gitty/src-tauri/icons/app-icon.png")
print("saved 1024x1024")
