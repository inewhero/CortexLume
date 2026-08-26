from __future__ import annotations

import argparse
from pathlib import Path
from typing import Callable

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
ASSET_ROOT = ROOT / "apps" / "desktop" / "assets"
ICON_PATH = ASSET_ROOT / "icon.png"
CANDIDATE_ROOT = ASSET_ROOT / "installer-candidates"
SELECTED_PATH = ASSET_ROOT / "install-loading.gif"
SIZE = (800, 800)
FRAME_COUNT = 48
FRAME_DURATION_MS = 55

GOLD = (238, 190, 53, 255)
GOLD_DIM = (118, 98, 39, 255)
WHITE = (238, 243, 241, 255)
STEEL = (50, 67, 71, 255)
STEEL_LIGHT = (94, 112, 114, 255)
PANEL = (19, 27, 30, 255)
PANEL_EDGE = (67, 82, 85, 255)


def canvas() -> Image.Image:
    image = Image.new("RGBA", SIZE, (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rectangle((136, 120, 664, 656), fill=PANEL, outline=PANEL_EDGE, width=2)
    return image


def prepare_logo(maximum: tuple[int, int]) -> Image.Image:
    logo = Image.open(ICON_PATH).convert("RGBA")
    content = logo.getbbox()
    if content:
        logo = logo.crop(content)
    logo.thumbnail(maximum, Image.Resampling.LANCZOS)
    return logo


def interface_font(filename: str, size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    path = Path("C:/Windows/Fonts") / filename
    return ImageFont.truetype(str(path), size) if path.exists() else ImageFont.load_default()


def draw_installer_copy(image: Image.Image) -> None:
    draw = ImageDraw.Draw(image)
    title_font = interface_font("consolab.ttf", 26)
    status_font = interface_font("consola.ttf", 16)
    draw.text((400, 477), "CortexLume Workstation", font=title_font, fill=WHITE, anchor="mm")
    draw.text((400, 563), "Installing...", font=status_font, fill=STEEL_LIGHT, anchor="mm")


def paste_logo(image: Image.Image, logo: Image.Image) -> None:
    center_y = 336
    image.alpha_composite(logo, ((SIZE[0] - logo.width) // 2, center_y - logo.height // 2))
    draw_installer_copy(image)


def wrapped_segment(
    draw: ImageDraw.ImageDraw,
    left: int,
    right: int,
    y: int,
    phase: float,
    length: float,
    *,
    width: int,
    fill: tuple[int, int, int, int],
) -> None:
    span = right - left
    start = phase * (span + length) - length
    end = start + length
    for offset in (-span - length, 0, span + length):
        clipped_start = max(left, left + start + offset)
        clipped_end = min(right, left + end + offset)
        if clipped_end > clipped_start:
            draw.line((clipped_start, y, clipped_end, y), fill=fill, width=width)


def linear_frames() -> list[Image.Image]:
    logo = prepare_logo((200, 200))
    frames: list[Image.Image] = []
    for index in range(FRAME_COUNT):
        phase = index / FRAME_COUNT
        image = canvas()
        paste_logo(image, logo)
        draw = ImageDraw.Draw(image)

        left, right, y = 204, 596, 530
        draw.line((left, y, right, y), fill=STEEL, width=3)
        draw.rectangle((left - 2, y - 6, left + 2, y + 6), fill=STEEL_LIGHT)
        draw.rectangle((right - 2, y - 6, right + 2, y + 6), fill=STEEL_LIGHT)
        wrapped_segment(draw, left, right, y, phase, 106, width=6, fill=GOLD)
        frames.append(image)
    return frames


def segmented_frames() -> list[Image.Image]:
    logo = prepare_logo((186, 186))
    frames: list[Image.Image] = []
    segment_count = 15
    segment_width = 19
    gap = 9
    total_width = segment_count * segment_width + (segment_count - 1) * gap
    left = (SIZE[0] - total_width) // 2

    for index in range(FRAME_COUNT):
        phase = index / FRAME_COUNT
        image = canvas()
        paste_logo(image, logo)
        draw = ImageDraw.Draw(image)

        active = phase * segment_count
        for segment in range(segment_count):
            circular_distance = min(
                abs(segment - active),
                abs(segment - active + segment_count),
                abs(segment - active - segment_count),
            )
            if circular_distance < 0.75:
                color = WHITE
            elif circular_distance < 2.4:
                color = GOLD
            elif circular_distance < 3.6:
                color = GOLD_DIM
            else:
                color = STEEL
            x = left + segment * (segment_width + gap)
            draw.rectangle((x, 524, x + segment_width, 532), fill=color)
        frames.append(image)
    return frames


def scanline_frames() -> list[Image.Image]:
    logo = prepare_logo((196, 196))
    frames: list[Image.Image] = []
    for index in range(FRAME_COUNT):
        phase = index / FRAME_COUNT
        image = canvas()
        paste_logo(image, logo)
        draw = ImageDraw.Draw(image)

        left, right = 184, 616
        top, bottom = 523, 534
        draw.rectangle((left, top, right, bottom), outline=STEEL_LIGHT, width=2)
        draw.line((left + 6, 529, right - 6, 529), fill=STEEL, width=2)

        center = left + (right - left) * phase
        for offset in range(-70, 71, 3):
            wrapped_x = left + ((center - left + offset) % (right - left))
            strength = 1 - abs(offset) / 71
            if strength > 0.74:
                color = WHITE
                height = 8
            elif strength > 0.34:
                color = GOLD
                height = 6
            else:
                color = GOLD_DIM
                height = 4
            draw.line((wrapped_x, 529 - height // 2, wrapped_x, 529 + height // 2), fill=color, width=3)
        frames.append(image)
    return frames


VARIANTS: dict[str, tuple[str, Callable[[], list[Image.Image]]]] = {
    "linear": ("Linear Rail", linear_frames),
    "segmented": ("Segmented Rail", segmented_frames),
    "scanline": ("Contained Scanline", scanline_frames),
}


def gif_frame(image: Image.Image, palette: Image.Image) -> Image.Image:
    alpha = image.getchannel("A")
    converted = image.convert("RGB").quantize(palette=palette, dither=Image.Dither.FLOYDSTEINBERG)
    transparent = alpha.point(lambda value: 255 if value <= 8 else 0)
    converted.paste(255, mask=transparent)
    palette = converted.getpalette()
    if palette is not None:
        palette[255 * 3 : 255 * 3 + 3] = [0, 0, 0]
        converted.putpalette(palette)
    return converted


def animation_palette(frame: Image.Image) -> Image.Image:
    critical_colors = [
        PANEL[:3],
        PANEL_EDGE[:3],
        GOLD[:3],
        GOLD_DIM[:3],
        WHITE[:3],
        STEEL[:3],
        STEEL_LIGHT[:3],
    ]
    sampled = frame.convert("RGB").quantize(colors=248, method=Image.Quantize.MAXCOVERAGE)
    sampled_palette = sampled.getpalette() or []
    colors = list(critical_colors)
    for index in range(248):
        offset = index * 3
        color = tuple(sampled_palette[offset : offset + 3])
        if len(color) == 3 and color not in colors:
            colors.append(color)
        if len(colors) == 255:
            break
    colors.extend([(0, 0, 0)] * (255 - len(colors)))
    colors.append((0, 0, 0))

    palette = Image.new("P", (1, 1))
    palette.putpalette([channel for color in colors for channel in color])
    return palette


def save_gif(frames: list[Image.Image], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    palette = animation_palette(frames[0])
    indexed = [gif_frame(frame, palette) for frame in frames]
    indexed[0].save(
        output,
        save_all=True,
        append_images=indexed[1:],
        duration=FRAME_DURATION_MS,
        loop=0,
        transparency=255,
        disposal=1,
        optimize=False,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate minimal transparent CortexLume installer animations.")
    parser.add_argument("--select", choices=VARIANTS, help="Copy the selected candidate to install-loading.gif.")
    args = parser.parse_args()

    selected_frames: list[Image.Image] | None = None
    for key, (_title, renderer) in VARIANTS.items():
        frames = renderer()
        output = CANDIDATE_ROOT / f"install-loading-{key}.gif"
        save_gif(frames, output)
        print(f"Generated {output.relative_to(ROOT)}")
        if args.select == key:
            selected_frames = frames

    if args.select and selected_frames:
        save_gif(selected_frames, SELECTED_PATH)
        print(f"Selected {args.select} at {SIZE[0]}x{SIZE[1]}: {SELECTED_PATH.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
