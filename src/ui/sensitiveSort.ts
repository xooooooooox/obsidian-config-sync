export function sortBySensitiveFirst<T extends { label: string }>(items: T[], isSensitive: (i: T) => boolean): T[] {
  return [...items].sort((a, b) => {
    const sa = isSensitive(a) ? 0 : 1;
    const sb = isSensitive(b) ? 0 : 1;
    return sa !== sb ? sa - sb : a.label.localeCompare(b.label);
  });
}
