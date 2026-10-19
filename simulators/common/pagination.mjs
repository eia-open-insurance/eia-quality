/**
 * Cursor pagination shaped like SPEC §7.6 and §12.2:
 * { data, page: { size, hasMore, nextCursor, total }, _links }.
 */
export function paginate(items, { searchParams, path, defaultSize = 25, maxSize = 200 } = {}) {
  const requested = Number(searchParams?.get('page[size]') ?? defaultSize);
  const size = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), maxSize) : defaultSize;

  let offset = 0;
  const after = searchParams?.get('page[after]');
  if (after) {
    try {
      const decoded = Number(Buffer.from(after, 'base64url').toString('utf8'));
      if (Number.isInteger(decoded) && decoded >= 0) offset = decoded;
    } catch {
      offset = 0;
    }
  }

  const data = items.slice(offset, offset + size);
  const hasMore = offset + size < items.length;
  const nextCursor = hasMore ? Buffer.from(String(offset + size), 'utf8').toString('base64url') : null;
  const selfQuery = new URLSearchParams(searchParams ?? undefined);
  selfQuery.set('page[size]', String(size));
  const selfHref = `${path}${selfQuery.toString() ? `?${selfQuery.toString()}` : ''}`;
  const nextHref = nextCursor
    ? `${path}?${(() => {
        const next = new URLSearchParams(searchParams ?? undefined);
        next.set('page[size]', String(size));
        next.set('page[after]', nextCursor);
        return next.toString();
      })()}`
    : null;

  return {
    data,
    page: { size, hasMore, nextCursor, total: items.length },
    _links: {
      self: { href: selfHref },
      next: nextHref ? { href: nextHref } : null,
    },
  };
}

/** Common list query filters used by the simulators. */
export function matchesFilters(item, searchParams, fields) {
  for (const field of fields) {
    const expected = searchParams.get(field);
    if (expected !== null && expected !== undefined && expected !== '' && String(item[field]) !== expected) return false;
  }
  return true;
}
