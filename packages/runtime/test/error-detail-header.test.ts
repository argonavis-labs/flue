import { describe, expect, it } from 'vitest';
import { encodeErrorDetail, ERROR_DETAIL_HEADER, toHttpResponse } from '../src/errors.ts';

type Detail = {
	type: string;
	message: string;
	stack?: string;
	causes?: Array<{ type: string; message: string; stack?: string }>;
};

const decode = (header: string): Detail =>
	JSON.parse(decodeURIComponent(escape(atob(header)))) as Detail;

const detailOf = (response: Response): Detail | undefined => {
	const header = response.headers.get(ERROR_DETAIL_HEADER);
	return header === null ? undefined : decode(header);
};

describe('error detail header', () => {
	it('carries the swallowed defect that the generic 500 body hides', async () => {
		const response = toHttpResponse(new TypeError('boom'));
		expect(response.status).toBe(500);
		// The body still leaks nothing — that contract is unchanged.
		expect(await response.clone().text()).not.toContain('boom');

		const detail = detailOf(response);
		expect(detail?.type).toBe('TypeError');
		expect(detail?.message).toBe('boom');
		expect(detail?.stack).toContain('TypeError');
	});

	it('carries the cause chain, which is often all that separates two failures', () => {
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

	it('walks a nested chain in order', () => {
		const root = new Error('root');
		const middle = new Error('middle', { cause: root });
		const detail = decode(encodeErrorDetail(new Error('outer', { cause: middle }))!);
		expect(detail.causes?.map((c) => c.message)).toEqual(['middle', 'root']);
	});

	it('bounds a pathological chain and survives a cycle', () => {
		const first = new Error('first');
		let current = first;
		for (let i = 0; i < 20; i++) current = new Error(`link-${i}`, { cause: current });
		expect(decode(encodeErrorDetail(current)!).causes).toHaveLength(4);

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

	it('describes a non-Error thrown value without stringifying it', () => {
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

	it('caps message length and frame count', () => {
		const long = new Error('m'.repeat(5000));
		long.stack = Array.from({ length: 60 }, (_, i) => `    at frame${i} (f.ts:${i}:1)`).join('\n');
		const detail = decode(encodeErrorDetail(long)!);
		expect(detail.message).toHaveLength(1000);
		expect(detail.stack?.split('\n')).toHaveLength(20);
	});
});
