const SCALE_MIN = 1;
const SCALE_MAX = 1.5;

function autoScale() {
  const physicalWidth = (window.screen?.width || window.innerWidth) * (window.devicePixelRatio || 1);
  if (physicalWidth >= 7000) return 1.2;
  if (physicalWidth >= 3500) return 1.1;
  return 1;
}

export function applyUiScale() {
  const scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, autoScale()));
  document.documentElement.style.setProperty("--ui-scale", String(scale));
  return scale;
}
