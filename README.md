# tiny-validate

Composable schema validation in one dependency-free file. Every error carries
the **path** to the field that failed, so a 422 can tell the client which input
to fix.

For the places a 60 kB validator is hard to justify: a serverless handler, a
Worker, a form.

## Install

```bash
npm install tiny-validate
```

## Use

```js
import v from 'tiny-validate';

const createUser = v.object({
  email: v.string().trim().lower().email(),
  name:  v.string().trim().min(2).max(80),
  age:   v.number().int().min(13).optional(),
  role:  v.enum('admin', 'editor', 'viewer').default('viewer'),
  tags:  v.array(v.string().min(1)).max(10).default(() => []),
});

createUser.parse({ email: '  A@B.CO ', name: '  Emre  ' });
// { email: 'a@b.co', name: 'Emre', role: 'viewer', tags: [] }
```

`parse` throws a `ValidationError`; `safeParse` returns
`{ ok, value, issues }`.

## Errors that name the field

```js
const schema = v.object({
  name: v.string().min(2),
  address: v.object({ city: v.string(), zip: v.string().pattern(/^\d{5}$/, 'must be 5 digits') }),
});

schema.safeParse({ name: 'a', address: { zip: 'abc' } }).issues;
// [ { path: ['name'],             message: 'must be at least 2 characters' },
//   { path: ['address', 'city'],  message: 'is required' },
//   { path: ['address', 'zip'],   message: 'must be 5 digits' } ]
```

Array items are indexed (`tags.1`), and **every** failure is collected, not
just the first — one round trip tells the user everything that's wrong.

For a form, `ValidationError#byField` is already the shape you want:

```js
try { schema.parse(body); }
catch (error) { return Response.json(error.byField, { status: 422 }); }
// { 'name': 'must be at least 2 characters', 'address.city': 'is required' }
```

## API

```js
v.string()   .trim() .lower() .min(n) .max(n) .pattern(re, msg) .email() .url()
v.number()   .int() .min(n) .max(n) .positive()
v.boolean()
v.literal(x)
v.enum('a', 'b')
v.array(item)      .min(n) .max(n)
v.object(shape)    .passthrough()
v.union(a, b)
v.any()
```

Every validator also has `.optional()`, `.default(value | () => value)`,
`.refine(predicate, message)` and `.map(fn)`.

## Opinions baked in

- **`NaN` is not a number.** `typeof NaN === 'number'` is the oldest trap in JS
  validation, and `Infinity` is rejected too.
- **`.url()` accepts `http(s)` only.** A `javascript:` URL passing a "is this a
  URL" check is a real vulnerability, not a technicality.
- **Unknown object keys are stripped by default.** Passing a whole request body
  into an update is how mass-assignment bugs happen. `.passthrough()` opts out.
- **Arrays are not objects.** `v.object({}).parse([])` fails.
- **Optional keys are absent, not `undefined`**, so `Object.keys()` and
  `JSON.stringify` behave.
- **Builders are immutable.** `const base = v.string(); base.max(3)` leaves
  `base` alone.

## Extending

```js
const weekday = v.number().int().min(0).max(6).refine((n) => n < 5, 'must be a weekday');
const cents   = v.number().map((n) => Math.round(n * 100));
```

## Test

```bash
npm test
```

21 tests, `node --test`, no framework to install.

## License

MIT
