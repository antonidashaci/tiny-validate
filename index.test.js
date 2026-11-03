import assert from 'node:assert/strict';
import { test } from 'node:test';

import v, { ValidationError } from './index.js';

test('primitives', () => {
  assert.equal(v.string().parse('hi'), 'hi');
  assert.equal(v.number().parse(42), 42);
  assert.equal(v.boolean().parse(false), false);
  assert.throws(() => v.string().parse(42), ValidationError);
  assert.throws(() => v.number().parse('42'), ValidationError);
});

test('NaN is not a number', () => {
  // typeof NaN === 'number' is the oldest trap in JS validation
  assert.throws(() => v.number().parse(NaN), /must be a number/);
  assert.throws(() => v.number().parse(Infinity), /must be finite/);
});

test('arrays are not objects', () => {
  assert.throws(() => v.object({}).parse([]), /must be an object/);
  assert.throws(() => v.array(v.string()).parse({}), /must be an array/);
});

test('string refinements', () => {
  assert.equal(v.string().min(2).max(4).parse('abc'), 'abc');
  assert.throws(() => v.string().min(5).parse('abc'), /at least 5 characters/);
  assert.equal(v.string().trim().parse('  x  '), 'x');
  assert.equal(v.string().lower().parse('ABC'), 'abc');
  assert.equal(v.string().trim().min(1).parse('  x  '), 'x');
});

test('email', () => {
  assert.equal(v.string().email().parse('a@b.co'), 'a@b.co');
  for (const bad of ['a@b', 'a b@c.co', '@b.co', 'a@@b.co', 'a@b.']) {
    assert.throws(() => v.string().email().parse(bad), ValidationError, bad);
  }
});

test('url rejects javascript:', () => {
  assert.equal(v.string().url().parse('https://a.test/x'), 'https://a.test/x');
  assert.throws(() => v.string().url().parse('javascript:alert(1)'), /http\(s\) URL/);
  assert.throws(() => v.string().url().parse('/relative'), ValidationError);
});

test('number refinements', () => {
  assert.equal(v.number().int().min(1).parse(5), 5);
  assert.throws(() => v.number().int().parse(1.5), /must be an integer/);
  assert.throws(() => v.number().positive().parse(0), /must be positive/);
  assert.throws(() => v.number().max(10).parse(11), /at most 10/);
});

test('enum and literal', () => {
  const role = v.enum('admin', 'user');
  assert.equal(role.parse('admin'), 'admin');
  assert.throws(() => role.parse('root'), /must be one of "admin", "user"/);
  assert.equal(v.literal(7).parse(7), 7);
  assert.throws(() => v.literal(7).parse(8), /must be 7/);
});

test('optional and default', () => {
  assert.equal(v.string().optional().parse(undefined), undefined);
  assert.equal(v.string().optional().parse(null), undefined);
  assert.equal(v.string().default('x').parse(undefined), 'x');
  assert.equal(v.number().default(() => 9).parse(null), 9);
  assert.throws(() => v.string().parse(undefined), /is required/);
});

test('nested objects report the full path', () => {
  const schema = v.object({
    name: v.string().min(2),
    address: v.object({
      city: v.string(),
      zip: v.string().pattern(/^\d{5}$/, 'must be 5 digits'),
    }),
  });

  const result = schema.safeParse({ name: 'a', address: { zip: 'abc' } });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.issues.map((i) => i.path.join('.')),
    ['name', 'address.city', 'address.zip'],
  );
});

test('array item paths are indexed', () => {
  const schema = v.object({ tags: v.array(v.string().min(2)) });
  const result = schema.safeParse({ tags: ['ok', 'x', 'fine'] });
  assert.equal(result.issues[0].path.join('.'), 'tags.1');
});

test('every error is collected, not just the first', () => {
  const schema = v.object({ a: v.string(), b: v.number(), c: v.boolean() });
  const result = schema.safeParse({});
  assert.equal(result.issues.length, 3);
});

test('byField gives a form-ready object', () => {
  const schema = v.object({ email: v.string().email() });
  try {
    schema.parse({ email: 'nope' });
    assert.fail('should have thrown');
  } catch (error) {
    assert.ok(error instanceof ValidationError);
    assert.deepEqual(error.byField, { email: 'must be an email address' });
  }
});

test('unknown keys are stripped by default', () => {
  const schema = v.object({ name: v.string() });
  assert.deepEqual(schema.parse({ name: 'a', isAdmin: true }), { name: 'a' });
  assert.deepEqual(
    schema.passthrough().parse({ name: 'a', isAdmin: true }),
    { name: 'a', isAdmin: true },
  );
});

test('optional keys are absent, not undefined', () => {
  const schema = v.object({ a: v.string(), b: v.string().optional() });
  assert.deepEqual(Object.keys(schema.parse({ a: 'x' })), ['a']);
});

test('array length', () => {
  assert.throws(() => v.array(v.string()).min(1).parse([]), /at least 1 items/);
  assert.throws(() => v.array(v.string()).max(1).parse(['a', 'b']), /at most 1 items/);
});

test('union', () => {
  const id = v.union(v.string().min(1), v.number().int());
  assert.equal(id.parse('abc'), 'abc');
  assert.equal(id.parse(7), 7);
  assert.throws(() => id.parse(true), /did not match any allowed shape/);
});

test('refine and map', () => {
  const even = v.number().int().refine((n) => n % 2 === 0, 'must be even');
  assert.equal(even.parse(4), 4);
  assert.throws(() => even.parse(3), /must be even/);

  const cents = v.number().map((n) => Math.round(n * 100));
  assert.equal(cents.parse(12.5), 1250);
});

test('builders are reusable and do not mutate each other', () => {
  const base = v.string();
  const short = base.max(3);
  assert.equal(base.parse('abcdef'), 'abcdef'); // base untouched
  assert.throws(() => short.parse('abcdef'), ValidationError);
});

test('a realistic request body', () => {
  const createUser = v.object({
    email: v.string().trim().lower().email(),
    name: v.string().trim().min(2).max(80),
    age: v.number().int().min(13).optional(),
    role: v.enum('admin', 'editor', 'viewer').default('viewer'),
    tags: v.array(v.string().min(1)).max(10).default(() => []),
  });

  assert.deepEqual(
    createUser.parse({ email: '  A@B.CO ', name: '  Emre  ' }),
    { email: 'a@b.co', name: 'Emre', role: 'viewer', tags: [] },
  );

  const bad = createUser.safeParse({ email: 'x', name: 'E', age: 9, role: 'root' });
  assert.deepEqual(bad.issues.map((i) => i.path[0]), ['email', 'name', 'age', 'role']);
});

test('a single error reads as one sentence', () => {
  try {
    v.object({ name: v.string().min(2) }).parse({ name: 'a' });
  } catch (error) {
    assert.equal(error.message, 'name must be at least 2 characters');
  }
});
