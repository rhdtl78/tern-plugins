export const settingsPanelCss = `
.sf-overlay[data-role="omo.settings"] {
  --sp-width: 256px;
  --sp-unit: 4px;
  --sp-gap: var(--sp-unit);
  --sp-inset: calc(3 * var(--sp-unit));
  --sp-radius: calc(4 * var(--sp-unit));
  --sp-track: calc(6 * var(--sp-unit));
  --sp-thumb: calc(7 * var(--sp-unit));
  --sp-tick: var(--sp-unit);
  --sp-title: 0.875rem;
  --sp-font: -apple-system, system-ui, sans-serif;
  --sp-surface: var(--card);
  --sp-ink: var(--t1);
  --sp-muted: var(--t2);
  --sp-border: var(--l3);
}
.sf-button[data-role="omo.settings-dismiss"] {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  pointer-events: auto;
}
.sf-overlay[data-role="omo.settings"] .sf-ov-card {
  width: min(var(--sp-width), calc(100% - 2 * var(--sp-gap))) !important;
  background: var(--sp-surface);
  color: var(--sp-ink);
  border-radius: var(--sp-radius);
  overflow: visible;
}
.sf-overlay[data-role="omo.settings"] .sf-ov-body {
  overflow: visible;
  padding: var(--sp-inset);
}
.sf-overlay[data-role="omo.settings"] .sf-ov-body:has([data-id="sp-list"]) {
  display: flex;
  min-height: 0;
  overflow: hidden;
}
.sf-ov-body:has([data-id="sp-list"]) :is([data-role="omo.settings-body"], [data-id="sp-list"], .sf-list-scroll) {
  min-height: 0;
}
.sf-overlay[data-role="omo.settings"] :is(.sf-text, .sf-item) { font-family: var(--sp-font); }
[data-role="omo.settings-body"] {
  gap: var(--sp-unit);
  min-width: 0;
}
[data-id="sp-header"], [data-id="sp-model-head"] {
  position: relative;
  align-items: center;
  justify-content: center;
  min-height: var(--sp-thumb);
}
[data-id="sp-title"] {
  font-size: var(--sp-title);
  font-weight: 550;
  color: var(--accent);
}
[data-id="sp-model-title"] { font-size: var(--sp-title); color: var(--sp-muted); }
[data-id="sp-speed"], [data-id="sp-header"] > [data-id="sp-close"],
[data-id="sp-model-head"] > :is([data-id="sp-back"], [data-id="sp-close"]) {
  position: absolute;
  top: 0;
}
[data-id="sp-speed"], [data-id="sp-back"] { left: 0; }
[data-id="sp-close"] { right: 0; }
[data-id="sp-speed-trigger"] { color: var(--accent); }
[data-id="sp-models"] {
  align-self: center;
  min-height: var(--sp-track);
  max-width: calc(100% - 2 * var(--sp-track));
  min-width: 0;
  color: var(--sp-muted);
}
[data-id="sp-models"]::after { content: "›"; }
[data-id="sp-models"] .sf-btn-label {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
[data-id="sp-speed"] { z-index: 1; }
[data-id="sp-speed-options"] {
  display: none;
  position: absolute;
  left: 100%;
  top: 0;
  width: calc(var(--sp-width) - var(--sp-thumb) - var(--sp-track) - 2 * var(--sp-inset));
  padding: var(--sp-unit);
  background: var(--sp-surface);
  border: 1px solid var(--sp-border);
  border-radius: var(--sp-inset);
  box-shadow: var(--shadow-pop, 0 var(--sp-unit) var(--sp-inset) var(--l3));
}
[data-id="sp-speed"]:hover > [data-id="sp-speed-options"],
[data-id="sp-speed"][data-role="omo.speed-open"] > [data-id="sp-speed-options"] { display: flex; }
[data-id="sp-speed-options"] > .sf-button {
  width: 100%;
  display: flex;
  text-align: left;
  justify-content: flex-start;
  min-height: var(--sp-thumb);
}
[data-id="sp-speed-options"] > .sf-button .sf-btn-ic { order: 1; margin-left: auto; }
[data-id="sp-speed-trigger"]:hover, [data-role="omo.settings-active"] { background: var(--l2); }
[data-id="sp-effort"] {
  margin-top: var(--sp-gap);
  margin-bottom: var(--sp-unit);
  min-width: 0;
}
[data-id="sp-effort"] :is(.sf-slider-label, .sf-slider-value, .sf-slider-ends, .sf-slider-bubble) {
  display: none !important;
}
[data-id="sp-effort"] .sf-slider-track {
  display: flex;
  align-items: center;
  padding: 0 calc(var(--sp-thumb) / 2);
  height: var(--sp-track);
  min-height: var(--sp-track);
  background: var(--l2);
  border-radius: var(--sp-track);
}
[data-id="sp-effort"] .sf-slider-rail {
  height: var(--sp-track);
  width: 100%;
  margin: 0 !important;
  background: transparent;
  position: relative;
  top: calc(-1 * var(--sp-unit));
}
[data-id="sp-effort"] .sf-slider-fill { background: var(--accent); height: 100%; }
[data-id="sp-effort"] .sf-slider-thumb {
  margin: 0 !important;
  top: 50% !important;
  transform: translate(-50%, -50%) !important;
  width: var(--sp-thumb) !important;
  height: var(--sp-thumb) !important;
  background: var(--sp-ink) !important;
  box-shadow: none !important;
  z-index: 1;
}
[data-id="sp-effort"][data-role="omo.effort-unknown"] :is(.sf-slider-thumb, .sf-slider-fill) { opacity: 0; }
[data-id="sp-effort"] .sf-slider-ticks { top: 50%; transform: none; }
[data-id="sp-effort"] .sf-slider-tick {
  width: var(--sp-tick);
  height: var(--sp-tick);
  border-radius: 50%;
  background: var(--sp-muted);
  transform: translate(-50%, -50%);
}
[data-id="sp-effort-preview"], [data-id="sp-filter"], [data-id="sp-message"] { color: var(--sp-muted); }
[data-id="sp-effort-preview"] { text-align: center; }
[data-id="sp-list"] .sf-list-scroll { scrollbar-width: thin; scrollbar-color: var(--sp-muted) transparent; }
[data-id="sp-list"] .sf-item { min-height: var(--sp-thumb); }
[data-id="sp-list"] .sf-item.sel { box-shadow: none; }
[data-id="sp-list"] .sf-item-value { color: var(--sp-ink); }
[data-id="sp-list"] .sf-item-label { min-width: 0; }
`;
