"""移除非 macOS Dock 图标外围的透明留白，保留原文件尺寸。"""
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
ICON_ROOT = ROOT / "src-tauri" / "icons"
SOURCE = ROOT / "src" / "favicon.png"
EXCLUDED = {"logo-source.png", "macos-icon-source.png"}


def trim_to_canvas(path: Path) -> None:
    image = Image.open(path).convert("RGBA")
    alpha_bbox = image.getchannel("A").getbbox()
    if not alpha_bbox or alpha_bbox == (0, 0, *image.size):
        return

    trimmed = image.crop(alpha_bbox).resize(image.size, Image.Resampling.LANCZOS)
    trimmed.save(path)
    print(f"trimmed {path.relative_to(ROOT)}: {image.size} {alpha_bbox}")

def regenerate_png_icons() -> None:
    """从 1024 源图标重新生成各尺寸 PNG,统一用 LANCZOS 下采样。

    旧的 32/64/128 等 PNG 是低质量缩放产物(边缘锯齿、细节糊),在 Windows
    打包元数据与窗口图标中显示模糊。统一从高分辨率源重新下采样。
    """
    source = Image.open(SOURCE).convert("RGBA")
    targets = {
        "32x32.png": (32, 32),
        "64x64.png": (64, 64),
        "128x128.png": (128, 128),
        "128x128@2x.png": (256, 256),
        "icon.png": (512, 512),
        "menu-bar-icon.png": (72, 72),
    }
    for name, size in targets.items():
        source.resize(size, Image.Resampling.LANCZOS).save(ICON_ROOT / name)
        print(f"regenerated {name}: {size}")

def rebuild_windows_icon() -> None:
    """从 1024 源图标用 LANCZOS 逐尺寸下采样组装 ICO。

    PIL 的 Image.save(format="ICO", sizes=[...]) 一次性从单一源缩放所有尺寸,
    内部对 ICO 多尺寸采用低质量算法(接近最近邻),小尺寸(16/24/32)边缘锯齿、
    细节糊成一团,在 Windows 任务栏/托盘(尤其 DPI 缩放下)显示模糊。
    改为对每个尺寸独立从 1024 高分辨率源 LANCZOS 下采样,再手动组装 ICO,
    保证每个嵌入位图都是锐利的高质量下采样。
    """
    source = Image.open(SOURCE).convert("RGBA")
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    frames = {s: source.resize(s, Image.Resampling.LANCZOS) for s in sizes}
    # PIL _save 对每个目标尺寸优先在 [im]+append_images 中找精确匹配的图,
    # 找不到才自行缩放;且若 im 本身尺寸 < 目标尺寸会被跳过。
    # 故主图取最大尺寸(256),其余尺寸作为 append_images,确保每个尺寸都命中预缩放图。
    largest = sizes[-1]
    rest = [frames[s] for s in sizes if s != largest]
    frames[largest].save(
        ICON_ROOT / "icon.ico",
        format="ICO",
        sizes=sizes,
        append_images=rest,
    )
    print("rebuilt src-tauri/icons/icon.ico")

def main() -> None:
    regenerate_png_icons()
    for path in sorted(ICON_ROOT.glob("*.png")):
        if path.name not in EXCLUDED:
            trim_to_canvas(path)
    trim_to_canvas(ROOT / "src" / "favicon.png")
    rebuild_windows_icon()


if __name__ == "__main__":
    main()
