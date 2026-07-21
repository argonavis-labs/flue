import { afterEach, describe, expect, it } from 'vitest';
import {
	configureErrorRendering,
	encodeErrorDetail,
	ERROR_DETAIL_HEADER,
	MethodNotAllowedError,
	toHttpResponse,
} from '../src/errors.ts';

type Detail = {
	type: string;
	message: string;
	stack?: string;
	causes?: Array<{ type: string; message: string; stack?: string }>;
};

const decode = (header: string): Detail =>
	JSON.parse(
		new TextDecoder().decode(Uint8Array.from(atob(header), (c) => c.charCodeAt(0))),
	) as Detail;

const headerOf = (response: Response): string | null => response.headers.get(ERROR_DETAIL_HEADER);

const detailOf = (response: Response): Detail | undefined => {
	const header = headerOf(response);
	return header === null ? undefined : decode(header);
};

const enabled = () => configureErrorRendering({ devMode: false, errorDetailHeader: true });

afterEach(() => configureErrorRendering({ devMode: false }));

describe('error detail header: opt-in gate', () => {
	// The header carries exactly what the generic 500 body exists to withhold, on
	// the one surface that reaches untrusted clients. A deployment with no edge
	// to strip it — flue's own default app is the edge — must be safe by default.
	it('is absent unless the deployment opts in', () => {
		expect(headerOf(toHttpResponse(new TypeError('boom')))).toBeNull();
	});

	it('is absent again once the deployment opts back out', () => {
		enabled();
		expect(headerOf(toHttpResponse(new TypeError('boom')))).not.toBeNull();
		configureErrorRendering({ devMode: false });
		expect(headerOf(toHttpResponse(new TypeError('boom')))).toBeNull();
	});

	it('never rides a client-facing HTTP error, opted in or not', () => {
		enabled();
		// A 4xx is a deliberate, client-addressed response — the negative contract
		// that matters most here, since hoisting the encode above the isHttp branch
		// would start leaking detail on every 400 with nothing else to catch it.
		expect(
			headerOf(toHttpResponse(new MethodNotAllowedError({ method: 'POST', allowed: ['GET'] }))),
		).toBeNull();
	});
});

describe('error detail header: payload', () => {
	it('carries the swallowed defect that the generic 500 body hides', async () => {
		enabled();
		const response = toHttpResponse(new TypeError('boom'));
		expect(response.status).toBe(500);
		// The body contract is unchanged: it is exactly the generic envelope.
		expect(await response.clone().json()).toEqual({
			error: {
				type: 'internal_error',
				message: 'An internal error occurred.',
				details: 'The server encountered an unexpected error while handling this request.',
			},
		});

		const detail = detailOf(response);
		expect(detail?.type).toBe('TypeError');
		expect(detail?.message).toBe('boom');
		expect(detail?.stack).toContain('TypeError');
	});

	it('carries the cause chain, which is often all that separates two failures', () => {
		enabled();
		// A wrapper built at one site has one message template and one stack no
		// matter what broke underneath; without the cause a consumer cannot tell
		// these apart at all.
		const wrap = (cause: Error) => new Error('could not initialize store', { cause });
		const schema = detailOf(toHttpResponse(wrap(new RangeError('unrecognized schema version'))));
		const disk = detailOf(toHttpResponse(wrap(new Error('disk I/O failure'))));

		expect(schema?.causes?.[0]?.type).toBe('RangeError');
		expect(schema?.causes?.[0]?.message).toBe('unrecognized schema version');
		expect(disk?.causes?.[0]?.message).toBe('disk I/O failure');
		expect(schema?.message).toBe(disk?.message);
	});

	it('walks a nested chain outward-in', () => {
		const root = new Error('root');
		const middle = new Error('middle', { cause: root });
		const detail = decode(encodeErrorDetail(new Error('outer', { cause: middle }))!);
		expect(detail.causes?.map((c) => c.message)).toEqual(['middle', 'root']);
	});

	it('bounds a pathological chain and survives a cycle', () => {
		const first = new Error('first');
		let current = first;
		for (let i = 0; i < 20; i++) current = new Error(`link-${i}`, { cause: current });
		expect(decode(encodeErrorDetail(current)!).causes!.length).toBeLessThanOrEqual(4);

		const a = new Error('a');
		const b = new Error('b', { cause: a });
		(a as { cause?: unknown }).cause = b;
		expect(() => encodeErrorDetail(b)).not.toThrow();
	});

	it('omits causes entirely when there are none', () => {
		expect(decode(encodeErrorDetail(new Error('lonely'))!).causes).toBeUndefined();
	});

	it('round-trips non-ASCII messages', () => {
		const detail = decode(encodeErrorDetail(new Error('schéma défaillant — ünïcode'))!);
		expect(detail.message).toBe('schéma défaillant — ünïcode');
	});

	it('reports a thrown primitive, which usually IS the message', () => {
		expect(decode(encodeErrorDetail('connection refused')!).message).toBe('connection refused');
		expect(decode(encodeErrorDetail(42)!).message).toBe('42');
	});

	it('describes a thrown object without putting its contents on the wire', () => {
		const detail = decode(encodeErrorDetail({ secret: 'do not leak' })!);
		expect(detail.type).toBe('object');
		expect(JSON.stringify(detail)).not.toContain('do not leak');
	});

	it('degrades to no header rather than throwing, so a diagnostic cannot break rendering', () => {
		const hostile = new Error('x');
		Object.defineProperty(hostile, 'stack', {
			get() {
				throw new Error('nope');
			},
		});
		expect(() => encodeErrorDetail(hostile)).not.toThrow();
		expect(encodeErrorDetail(hostile)).toBeUndefined();
		// NOTE: `toHttpResponse(hostile)` still throws, but from the pre-existing
		// `flueLog.error(err)` call that runs before this header is built — a
		// separate robustness gap, deliberately not widened or fixed here.
	});
});

describe('error detail header: size', () => {
	const bigStack = (label: string) =>
		[
			`Error: ${label}`,
			...Array.from(
				{ length: 60 },
				(_, i) => `    at ${label}Frame${i} (/very/long/bundled/path/index.js:${i}:${i})`,
			),
		].join('\n');

	const deepChain = (message: string) => {
		let current = new Error(`${message}-root`);
		current.stack = bigStack('root');
		for (let i = 0; i < 6; i++) {
			const next: Error = new Error(message.repeat(200), { cause: current });
			next.stack = bigStack(`link${i}`);
			current = next;
		}
		return current;
	};

	// Per-field character caps do not bound header BYTES: base64 inflates 4/3, a
	// CJK character is 3 bytes, and per-link caps multiply by chain depth. Left
	// unbounded this exceeds Node's 16 KB maxHeaderSize, and the client gets a
	// transport error instead of the 500 — the diagnostic destroying the report.
	it('keeps a worst-case ASCII chain inside the budget', () => {
		expect(encodeErrorDetail(deepChain('m'))!.length).toBeLessThanOrEqual(4096);
	});

	it('keeps a worst-case multi-byte chain inside the budget', () => {
		expect(encodeErrorDetail(deepChain('猫'))!.length).toBeLessThanOrEqual(4096);
	});

	it('bounds the header on the real response, not just the encoder', () => {
		enabled();
		const header = headerOf(toHttpResponse(deepChain('猫')));
		expect(header!.length).toBeLessThanOrEqual(4096);
	});

	it('still reports the outer error after degrading', () => {
		// Shedding detail must not shed identity — the outer type and message are
		// what make the report actionable at all.
		const detail = decode(encodeErrorDetail(deepChain('m'))!);
		expect(detail.type).toBe('Error');
		expect(detail.message.length).toBeGreaterThan(0);
	});
});
