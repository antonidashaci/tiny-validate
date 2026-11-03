/**
 * A composable schema validator in one file, with no dependencies.
 *
 * Built for the places a 60 kB validator is hard to justify: a serverless
 * handler, a Worker, a form. What it does keep is the part that actually
 * matters in production - every error carries the **path** to the field that
 * failed, so a 422 can tell the client which input to fix.
 */

/** Thrown by `.parse()`. Carries every failure, not just the first. */
export class ValidationError extends Error {
  /** @param {Array<{ path: string[], message: string }>} issues */
  constructor(issues) {
    super(
      issues.length === 1
        ? formatIssue(issues[0])
        : `${issues.length} validation errors:\n` + issues.map((i) => `  - ${formatIssue(i)}`).join('\n'),
    );
    this.name = 'ValidationError';
    this.issues = issues;
  }

  /** `{ 'address.city': 'is required' }` - the shape a form wants. */
  get byField() {
    return Object.fromEntries(
      this.issues.map((issue) => [issue.path.join('.') || '(root)', issue.message]),
    );
  }
}

function formatIssue(issue) {
  const where = issue.path.length ? issue.path.join('.') : 'value';
  return `${where} ${issue.message}`;
}

const ok = (value) => ({ ok: true, value, issues: [] });
const fail = (issues) => ({ ok: false, value: undefined, issues });
const issue = (message, path = []) => ({ path, message });

/**
 * Copy a validator so `.min(2).max(4)` does not mutate the one it came from.
 * A plain function, not a private method: a clone made with `Object.create`
 * has no private brand, so the next chained call would throw on it.
 * @template T @param {T} validator @returns {T}
 */
function derive(validator) {
  const clone = Object.create(Object.getPrototypeOf(validator));
  return Object.assign(clone, validator);
}

/**
 * Base class. A validator is a `check(value, path)` returning
 * `{ ok, value, issues }`; everything else is built on that.
 */
class Validator {
  /** @param {(value: unknown, path: string[]) => { ok: boolean, value: any, issues: any[] }} check */
  constructor(check) {
    this.check = check;
    this._optional = false;
    this._default = undefined;
    this._hasDefault = false;
  }

  /** @returns {{ ok: boolean, value?: any, issues: Array<{path: string[], message: string}> }} */
  safeParse(value, path = []) {
    if (value === undefined || value === null) {
      if (this._hasDefault) return ok(typeof this._default === 'function' ? this._default() : this._default);
      if (this._optional) return ok(undefined);
      return fail([issue('is required', path)]);
    }
    return this.check(value, path);
  }

  /** @throws {ValidationError} */
  parse(value) {
    const result = this.safeParse(value, []);
    if (!result.ok) throw new ValidationError(result.issues);
    return result.value;
  }

  /** Allow `undefined` and `null`. */
  optional() {
    const clone = derive(this);
    clone._optional = true;
    return clone;
  }

  /** Allow absence, substituting `value` (or `value()`). */
  default(value) {
    const clone = derive(this);
    clone._hasDefault = true;
    clone._default = value;
    return clone;
  }

  /**
   * Add an arbitrary predicate.
   * @param {(value: any) => boolean} predicate
   * @param {string} message e.g. 'must be a weekday'
   */
  refine(predicate, message) {
    const previous = this.check;
    const clone = derive(this);
    clone.check = (value, path) => {
      const result = previous.call(this, value, path);
      if (!result.ok) return result;
      return predicate(result.value) ? result : fail([issue(message, path)]);
    };
    return clone;
  }

  /** Transform after validation. */
  map(fn) {
    const previous = this.check;
    const clone = derive(this);
    clone.check = (value, path) => {
      const result = previous.call(this, value, path);
      return result.ok ? ok(fn(result.value)) : result;
    };
    return clone;
  }
}

class StringValidator extends Validator {
  constructor() {
    super((value, path) =>
      typeof value === 'string' ? ok(value) : fail([issue('must be a string', path)]));
  }

  trim() {
    return this.map((s) => s.trim());
  }

  lower() {
    return this.map((s) => s.toLowerCase());
  }

  min(n) {
    return this.refine((s) => s.length >= n, `must be at least ${n} characters`);
  }

  max(n) {
    return this.refine((s) => s.length <= n, `must be at most ${n} characters`);
  }

  pattern(re, message = `must match ${re}`) {
    return this.refine((s) => re.test(s), message);
  }

  /** Deliberately permissive: one @, no spaces, a dot in the domain. */
  email() {
    return this.pattern(/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/, 'must be an email address');
  }

  /** http(s) only - `javascript:` passing a URL check is a real bug. */
  url() {
    return this.refine((s) => {
      try {
        return ['http:', 'https:'].includes(new URL(s).protocol);
      } catch {
        return false;
      }
    }, 'must be an http(s) URL');
  }
}

class NumberValidator extends Validator {
  constructor() {
    super((value, path) => {
      // Reject NaN: typeof NaN === 'number' is the oldest trap in JS validation.
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return fail([issue('must be a number', path)]);
      }
      return Number.isFinite(value) ? ok(value) : fail([issue('must be finite', path)]);
    });
  }

  int() {
    return this.refine(Number.isInteger, 'must be an integer');
  }

  min(n) {
    return this.refine((v) => v >= n, `must be at least ${n}`);
  }

  max(n) {
    return this.refine((v) => v <= n, `must be at most ${n}`);
  }

  positive() {
    return this.refine((v) => v > 0, 'must be positive');
  }
}

class BooleanValidator extends Validator {
  constructor() {
    super((value, path) =>
      typeof value === 'boolean' ? ok(value) : fail([issue('must be a boolean', path)]));
  }
}

class LiteralValidator extends Validator {
  constructor(expected) {
    super((value, path) =>
      value === expected ? ok(value) : fail([issue(`must be ${JSON.stringify(expected)}`, path)]));
  }
}

class EnumValidator extends Validator {
  constructor(values) {
    super((value, path) =>
      values.includes(value)
        ? ok(value)
        : fail([issue(`must be one of ${values.map((v) => JSON.stringify(v)).join(', ')}`, path)]));
  }
}

class ArrayValidator extends Validator {
  constructor(item) {
    super((value, path) => {
      if (!Array.isArray(value)) return fail([issue('must be an array', path)]);
      const out = [];
      const issues = [];
      value.forEach((element, index) => {
        const result = item.safeParse(element, [...path, String(index)]);
        if (result.ok) out.push(result.value);
        else issues.push(...result.issues);
      });
      return issues.length ? fail(issues) : ok(out);
    });
  }

  min(n) {
    return this.refine((a) => a.length >= n, `must have at least ${n} items`);
  }

  max(n) {
    return this.refine((a) => a.length <= n, `must have at most ${n} items`);
  }
}

class ObjectValidator extends Validator {
  /** @param {Record<string, Validator>} shape */
  constructor(shape, { strip = true } = {}) {
    super((value, path) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return fail([issue('must be an object', path)]);
      }
      const out = {};
      const issues = [];
      for (const [key, validator] of Object.entries(shape)) {
        const result = validator.safeParse(value[key], [...path, key]);
        if (!result.ok) issues.push(...result.issues);
        else if (result.value !== undefined) out[key] = result.value;
      }
      if (!strip) {
        for (const key of Object.keys(value)) {
          if (!(key in shape)) out[key] = value[key];
        }
      }
      return issues.length ? fail(issues) : ok(out);
    });
    this.shape = shape;
  }

  /** Keep keys the schema does not mention. Off by default: unknown keys from
   * a request body are how mass-assignment bugs happen. */
  passthrough() {
    return new ObjectValidator(this.shape, { strip: false });
  }
}

class UnionValidator extends Validator {
  constructor(options) {
    super((value, path) => {
      for (const option of options) {
        const result = option.safeParse(value, path);
        if (result.ok) return result;
      }
      return fail([issue('did not match any allowed shape', path)]);
    });
  }
}

/** Schema builders. */
export const v = {
  string: () => new StringValidator(),
  number: () => new NumberValidator(),
  boolean: () => new BooleanValidator(),
  literal: (value) => new LiteralValidator(value),
  enum: (...values) => new EnumValidator(values.flat()),
  array: (item) => new ArrayValidator(item),
  object: (shape) => new ObjectValidator(shape),
  union: (...options) => new UnionValidator(options.flat()),
  any: () => new Validator((value) => ok(value)),
};

export default v;
