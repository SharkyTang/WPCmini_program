# Design QA

- Reference: `/Users/shaoqitang/Downloads/IMG_0706.jpg`
- Target: case detail thumbnail strip and case admin image picker
- WeChat DevTools check:
  - The detail page keeps the existing thumbnail size, spacing, selected border, and tap behavior.
  - The thumbnail container is exposed as a native horizontally scrollable region.
  - A three-image case renders all thumbnails without clipping.
  - The case admin page renders nine image slots and the “最多 9 张” hint.
- Automated checks:
  - Nine gallery images remain available on detail pages.
  - Selecting or swiping to later images still upgrades only the requested display image.
  - Upload selection, server validation, catalog output, image processing, and backfill all enforce nine images.
  - Original uploads and variant processing never exceed three concurrent tasks.
- Final result: passed.
