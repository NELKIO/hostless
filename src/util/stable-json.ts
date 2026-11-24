/**
 * Deterministic JSON: object keys sorted, `undefined` members dropped (as JSON.stringify does),
 * non-finite numbers rejected. Two devices that hold equal values produce byte-identical text,
 * which is what signatures, hashes and "does the relay already hold this?" checks rely on.
 */
export function stableJson(value: unknown): string {
  return write(value, new Set());
}

function write(value: unknown, stack: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('stableJson: non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (stack.has(value)) throw new TypeError('stableJson: cycle');
      stack.add(value);
      try {
        if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? 'null' : write(item, stack))).join(',')}]`;
        const toJSON = (value as { toJSON?: () => unknown }).toJSON;
        if (typeof toJSON === 'function') return write(toJSON.call(value), stack);
        const keys = Object.keys(value).sort();
        const parts: string[] = [];
        for (const key of keys) {
          const item = (value as Record<string, unknown>)[key];
          if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
          parts.push(`${JSON.stringify(key)}:${write(item, stack)}`);
        }
        return `{${parts.join(',')}}`;
      } finally {
        stack.delete(value);
      }
    }
    case 'bigint':
      throw new TypeError('stableJson: bigint');
    default:
      return 'null';
  }
}

/** Plain JSON object check (not array, not null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON.parse that returns `undefined` instead of throwing. */
export function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Structured deep copy of a JSON value. */
export function cloneJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}
