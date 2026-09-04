export function handNaturalWidth(count: number): string {
  const visibleCount = Number.isFinite(count) ? Math.max(1, Math.trunc(count)) : 1;
  if (visibleCount === 1) {
    return "var(--hand-card-width)";
  }
  return `calc(var(--hand-card-width)${" + var(--hand-card-step)".repeat(visibleCount - 1)})`;
}
