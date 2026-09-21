/** Control-byte density and UTF-8 validity over at most `limit` bytes; NUL is binary on sight. */
export function looksBinary(buffer: Buffer, limit = buffer.length): boolean {
	const end = Math.min(buffer.length, limit);
	let controlBytes = 0;
	for (let index = 0; index < end; index += 1) {
		const byte = buffer[index] ?? 0;
		if (byte === 0) return true;
		if (byte < 9 || (byte > 13 && byte < 32) || byte === 127) controlBytes += 1;
	}
	if (end > 0 && controlBytes / end > 0.3) return true;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, end), { stream: true });
		return false;
	} catch {
		return true;
	}
}
