from pathlib import Path
import platform
import subprocess
import tempfile

import cv2
import numpy as np
from PIL import Image, ImageChops, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src-tauri" / "icons" / "logo-source.png"
OUTPUT = ROOT / "src-tauri" / "icons" / "macos-icon-source.png"
ICNS_OUTPUT = ROOT / "src-tauri" / "icons" / "icon.icns"


def build_icns(icon: Image.Image) -> None:
    """把带安全边距的源图生成 macOS 的多尺寸图标。"""
    if platform.system() != "Darwin":
        return

    sizes = (16, 32, 128, 256, 512)
    with tempfile.TemporaryDirectory(prefix="hello-gitty-iconset-") as temporary:
        iconset = Path(temporary) / "HelloGitty.iconset"
        iconset.mkdir()
        for size in sizes:
            icon.resize((size, size), Image.Resampling.LANCZOS).save(
                iconset / f"icon_{size}x{size}.png"
            )
            icon.resize((size * 2, size * 2), Image.Resampling.LANCZOS).save(
                iconset / f"icon_{size}x{size}@2x.png"
            )

        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(ICNS_OUTPUT)],
            check=True,
        )

    alpha_bbox = icon.getchannel("A").getbbox()
    expected = (92, 92, 932, 932)
    if alpha_bbox != expected:
        raise RuntimeError(f"macOS 图标透明边界异常: {alpha_bbox}, 预期 {expected}")
    print(f"generated {ICNS_OUTPUT.relative_to(ROOT)} with safe area {alpha_bbox}")


def main() -> None:
    rgb = np.array(Image.open(SOURCE).convert("RGB"))
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)

    # The supplied checkerboard is low-saturation; the purple container is not.
    purple = ((hsv[:, :, 1] > 42) & (hsv[:, :, 2] > 70)).astype(np.uint8) * 255
    purple = cv2.morphologyEx(purple, cv2.MORPH_CLOSE, np.ones((21, 21), np.uint8))
    contours, _ = cv2.findContours(purple, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        raise RuntimeError("没有识别到紫色 Logo 容器")

    container = np.zeros(purple.shape, dtype=np.uint8)
    cv2.drawContours(container, [max(contours, key=cv2.contourArea)], -1, 255, thickness=cv2.FILLED)
    container = cv2.morphologyEx(container, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    # Remove the source image's white matte from the outer edge before scaling.
    container = cv2.erode(container, np.ones((5, 5), np.uint8), iterations=1)

    ys, xs = np.where(container > 0)
    x0, x1 = xs.min(), xs.max() + 1
    y0, y1 = ys.min(), ys.max() + 1
    cropped = rgb[y0:y1, x0:x1]
    alpha = container[y0:y1, x0:x1]
    output = np.dstack((cropped, alpha))
    icon = Image.fromarray(output, "RGBA")

    # Add restrained micro-neumorphic depth to the cat edge only.
    pixels = np.array(icon)
    cat = Image.fromarray(
        np.all(pixels[:, :, :3] >= 210, axis=2).astype(np.uint8) * 255, "L"
    )
    width, height = icon.size
    soft_shadow = cat.filter(ImageFilter.GaussianBlur(5)).point(lambda value: round(value * 0.18))
    shadow_mask = Image.new("L", icon.size)
    shadow_mask.paste(soft_shadow.crop((0, 0, width - 4, height - 4)), (4, 4))
    shadow = Image.new("RGBA", icon.size, (43, 24, 105, 0))
    shadow.putalpha(ImageChops.multiply(shadow_mask, Image.fromarray(alpha, "L")))
    icon = Image.alpha_composite(shadow, icon)

    edge = ImageChops.subtract(cat, cat.filter(ImageFilter.MinFilter(5)))
    edge_arr = np.array(edge, dtype=np.float32)
    yy, xx = np.mgrid[0:height, 0:width]
    light_direction = np.clip(1.0 - (yy / height) * 0.75 - (xx / width) * 0.25, 0, 1)
    edge = Image.fromarray((edge_arr * light_direction * 0.16).astype(np.uint8), "L")
    highlight = Image.new("RGBA", icon.size, (255, 255, 255, 0))
    highlight.putalpha(ImageChops.multiply(edge, Image.fromarray(alpha, "L")))
    icon = Image.alpha_composite(icon, highlight)
    # Keep optical safe space so Dock sizing matches neighboring macOS icons.
    icon = icon.resize((1024, 1024), Image.Resampling.LANCZOS)
    padded = icon.resize((840, 840), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    canvas.alpha_composite(padded, ((1024 - padded.width) // 2, (1024 - padded.height) // 2))
    canvas.save(OUTPUT)
    build_icns(canvas)


if __name__ == "__main__":
    main()
