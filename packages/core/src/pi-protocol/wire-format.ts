/** Version 4 includes built-in feature activation in the project's extension plan. */
export const PI_WORKER_PROTOCOL_VERSION = 4 as const;

export const PI_WORKER_REQUEST_MAX_BYTES = 64 * 1024 * 1024;

export const PI_WORKER_RESPONSE_MAX_BYTES = 128 * 1024 * 1024;

export const PI_WORKER_EVENT_MAX_BYTES = 64 * 1024 * 1024;

export const PI_WORKER_RESPONSE_CHUNK_MAX_CHARS = 1024 * 1024;

export const PI_WORKER_RESPONSE_CHUNK_MAX_COUNT = Math.ceil(
	PI_WORKER_RESPONSE_MAX_BYTES / PI_WORKER_RESPONSE_CHUNK_MAX_CHARS,
);

export const PI_WORKER_REQUEST_CAPACITY = 256;

export const PI_WORKER_REVERSE_REQUEST_CAPACITY = 128;
