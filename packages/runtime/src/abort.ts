/** Cancellation primitives shared by prompt, skill, task, and shell calls. */

import type { CallHandle } from './types.ts';

/** Build a standard `AbortError` (`DOMException`) carrying the signal's reason as `cause`. */
export function abortErrorFor(signal: AbortSignal): Error {
	const reason = signal.reason;
	const message =
		reason instanceof Error && reason.message
			? reason.message
			: typeof reason === 'string' && reason
				? reason
				: 'The operation was aborted.';
	const error = new DOMException(message, 'AbortError');
	// `cause` is read-only on DOMException in some runtimes.
	try {
		Object.defineProperty(error, 'cause', { value: reason, configurable: true });
	} catch {
		/* leave cause unset */
	}
	return error;
}

/** Await `promise`, rejecting on abort; the orphan stays observed so its late settlement never becomes an unhandled rejection. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		promise.catch(() => {});
		return Promise.reject(abortErrorFor(signal));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortErrorFor(signal));
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener('abort', onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener('abort', onAbort);
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}

/**
 * Translate a millisecond deadline into an `AbortSignal` and compose it with
 * the caller's signal. Single implementation of the timeout-to-signal
 * cancellation composition shared by the LLM bash tool and the
 * signal-translating `SessionEnv` adapters (bash factory, local).
 *
 * Returns both signals: callers that distinguish a recoverable timeout from
 * a host abort (the bash tool's 124-shaped result) need `timeoutSignal` on
 * its own; everything downstream gets `mergedSignal`.
 */
export function composeTimeoutSignal(
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
): { timeoutSignal: AbortSignal | undefined; mergedSignal: AbortSignal | undefined } {
	const timeoutSignal = typeof timeoutMs === 'number' ? AbortSignal.timeout(timeoutMs) : undefined;
	const mergedSignal =
		signal && timeoutSignal ? AbortSignal.any([signal, timeoutSignal]) : (signal ?? timeoutSignal);
	return { timeoutSignal, mergedSignal };
}

/**
 * Wrap an async `run` function in a `CallHandle`. The handle's internal
 * signal fires when `externalSignal` aborts or when `handle.abort()` is
 * called.
 */
export function createCallHandle<T>(
	externalSignal: AbortSignal | undefined,
	run: (signal: AbortSignal) => Promise<T>,
): CallHandle<T> {
	const controller = new AbortController();

	let externalListener: (() => void) | undefined;
	if (externalSignal) {
		if (externalSignal.aborted) {
			controller.abort(externalSignal.reason);
		} else {
			externalListener = () => controller.abort(externalSignal.reason);
			externalSignal.addEventListener('abort', externalListener, { once: true });
		}
	}

	const promise = run(controller.signal).finally(() => {
		if (externalListener && externalSignal) {
			externalSignal.removeEventListener('abort', externalListener);
		}
	});
	// Callers may never await the handle (fire-and-forget calls, or aborting
	// and dropping the handle) — keep a rejection from surfacing as an
	// unhandled-rejection crash. `then()` below still returns the rejecting
	// promise to consumers that do await.
	promise.catch(() => {});

	return {
		signal: controller.signal,
		abort(reason?: unknown) {
			controller.abort(reason);
		},
		// CallHandle implements the full Promise interface by delegating to
		// the internal promise, so callers can `await handle` or chain
		// `.then()`/`.catch()`/`.finally()` without subclassing Promise.
		// biome-ignore lint/suspicious/noThenProperty: intentional thenable
		then(onFulfilled, onRejected) {
			return promise.then(onFulfilled, onRejected);
		},
		catch(onRejected) {
			return promise.catch(onRejected);
		},
		finally(onFinally) {
			return promise.finally(onFinally);
		},
		[Symbol.toStringTag]: 'Promise',
	};
}
