# CortexLume interface standard

CortexLume uses a compact workstation interface. Density comes from a regular grid and concise labels, not from shrinking controls below comfortable reading or interaction sizes.

## Type scale

- `12px` — panel titles and prominent card headings.
- `11px` — input values and primary data.
- `10px` — buttons, body copy, row labels, and section titles.
- `9px` — metadata, units, captions, and secondary status.
- `7–8px` — reserved for labels rendered inside the 3D scene or very small spatial markers.

Arial is the interface face. Cascadia Mono is reserved for coordinates, identifiers, units, numeric values, and machine status.

## Controls

- Standard buttons, inputs, selects, and segmented controls are `30px` high.
- Compact icon controls are `28px` high and must have an accessible name.
- Controls in the same row share a baseline and height.
- Text buttons use the same `10px` semibold label style. Workflow buttons must not use a smaller scale.
- A segmented button is both the mode selector and its on/off control: one active segment at most, and clicking the active segment may turn the mode off.

## Alignment and spacing

- Labels and names align left; numeric values, units, percentages, and short status values align right.
- Section headers use the same inset and height across both side panels.
- Use the `4 / 6 / 8 / 10px` spacing rhythm. Avoid one-off offsets unless required by the 3D overlay geometry.
- Dense rows remain at least `30px` high. Long names take the flexible column; numeric columns use `max-content`.

## State and emphasis

- Dark fill indicates an active neutral mode; yellow is reserved for the primary action or selected mapping state.
- Disabled controls retain their layout and use reduced opacity.
- Keyboard focus uses the yellow focus ring consistently on buttons, inputs, and selects.
- Warning color is reserved for destructive actions, invalid data, and layout collisions.
