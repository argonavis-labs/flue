import type { Channel, HttpChannelOptions } from './types.ts';

export function http(_options?: HttpChannelOptions): Channel {
	return {
		name: 'http',
		mount: 'top',
		app() {
			throw new Error('[flue] http() channel delivery is not implemented yet.');
		},
	};
}
