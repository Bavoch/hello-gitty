"""移除非 macOS Dock 图标外围的透明留白，保留原文件尺寸。"""
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
ICON_ROOT = ROOT / "src-tauri" / "icons"
EXCLUDED = {"logo-source.png", "macos-icon-source.png"}


def trim_to_canvas(path: Path) -> None:
    image = Image.open(path).convert("RGBA")
    alpha_bbox = image.getchannel("A").getbbox()
    if not alpha_bbox or alpha_bbox == (0, 0, *image.size):
        return

    trimmed = image.crop(alpha_bbox).resize(image.size, Image.Resampling.LANCZOS)
    trimmed.save(path)
    print(f"trimmed {path.relative_to(ROOT)}: {image.size} {alpha_bbox}")


def rebuild_windows_icon() -> None:
    source = Image.open(ICON_ROOT / "icon.png").convert("RGBA")
    source.save(
        ICON_ROOT / "icon.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print("rebuilt src-tauri/icons/icon.ico")


def main() -> None:
    for path in sorted(ICON_ROOT.glob("*.png")):
        if path.name not in EXCLUDED:
            trim_to_canvas(path)
    trim_to_canvas(ROOT / "src" / "favicon.png")
    rebuild_windows_icon()


if __name__ == "__main__":
    main()
