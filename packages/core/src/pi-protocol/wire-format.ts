/** Version 5 assigns a worker role before loading project resources. */
export const PI_WORKER_PROTOCOL_VERSION = 5 as const;

export const PI_WORKER_REQUEST_MAX_BYTES = 64 * 1024 * 1024;

export const PI_WORKER_RESPONSE_MAX_BYTES = 128 * 1024 * 1024;

export const PI_WORKER_EVENT_MAX_BYTES = 64 * 1024 * 1024;

export const PI_WORKER_RESPONSE_CHUNK_MAX_CHARS = 1024 * 1024;

export const PI_WORKER_RESPONSE_CHUNK_MAX_COUNT = Math.ceil(
	PI_WORKER_RESPONSE_MAX_BYTES / PI_WORKER_RESPONSE_CHUNK_MAX_CHARS,
);

export const PI_WORKER_REQUEST_CAPACITY = 256;

export const PI_WORKER_REVERSE_REQUEST_CAPACITY = 128;
