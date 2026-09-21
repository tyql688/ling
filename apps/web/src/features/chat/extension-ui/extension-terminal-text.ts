/** ESC (0x1B): introducer for CSI/OSC and other control sequences. */
const ESCAPE = 0x1b;
/** BEL (0x07): traditional terminator of some OSC strings. */
const BELL = 0x07;
/** ST (0x9C): 8-bit string terminator, equivalent to the ESC\ path. */
const STRING_TERMINATOR = 0x9c;

function isCsiFinalByte(code: number): boolean {
	return code >= 0x40 && code <= 0x7e;
}

function skipControlString(value: string, offset: number, bellTerminates: boolean): number {
	let index = offset;
	while (index < value.length) {
		const code = value.charCodeAt(index);
		if ((bellTerminates && code === BELL) || code === STRING_TERMINATOR) return index + 1;
		if (code === ESCAPE && value.charCodeAt(index + 1) === 0x5c) return index + 2;
		index += 1;
	}
	return value.length;
}

function readCsi(value: string, offset: number): { end: number; sequence: string | null } {
	let index = offset;
	while (index < value.length && !isCsiFinalByte(value.charCodeAt(index))) index += 1;
	if (index >= value.length) return { end: value.length, sequence: null };
	const final = value[index] ?? "";
	const parameters = value.slice(offset, index);
	return {
		end: index + 1,
		sequence: final === "m" && /^[\d:;]*$/u.test(parameters) ? `\u001b[${parameters}m` : null,
	};
}

function skipEscapeSequence(value: string, offset: number): number {
	let index = offset;
	while (index < value.length) {
		const code = value.charCodeAt(index);
		if (code < 0x20 || code > 0x2f) break;
		index += 1;
	}
	if (index < value.length) {
		const final = value.charCodeAt(index);
		if (final >= 0x30 && final <= 0x7e) return index + 1;
	}
	return Math.min(offset + 1, value.length);
}

/**
 * Projects a Pi TUI snapshot into browser-safe terminal text. SGR styling is kept for
 * ansi-to-react; OSC hyperlinks, cursor movement, device controls, and other terminal
 * side effects are removed. The visible label inside an OSC 8 link remains intact.
 */
export function projectExtensionTerminalText(value: string): string {
	let output = "";
	let index = 0;
	while (index < value.length) {
		const code = value.charCodeAt(index);
		if (code === ESCAPE) {
			const next = value.charCodeAt(index + 1);
			if (next === 0x5b) {
				const csi = readCsi(value, index + 2);
				if (csi.sequence !== null) output += csi.sequence;
				index = csi.end;
				continue;
			}
			if (next === 0x5d) {
				index = skipControlString(value, index + 2, true);
				continue;
			}
			if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
				index = skipControlString(value, index + 2, false);
				continue;
			}
			index = skipEscapeSequence(value, index + 1);
			continue;
		}
		if (code === 0x9b) {
			const csi = readCsi(value, index + 1);
			if (csi.sequence !== null) output += csi.sequence;
			index = csi.end;
			continue;
		}
		if (code === 0x9d) {
			index = skipControlString(value, index + 1, true);
			continue;
		}
		if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
			index = skipControlString(value, index + 1, false);
			continue;
		}
		if (code === 0x09) {
			// Pi TUI normalizes a visible tab to three spaces. Browser tab sizing varies
			// by element/CSS, so materialize the same stable projection here.
			output += "   ";
			index += 1;
			continue;
		}
		if ((code < 0x20 && code !== 0x0a) || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
			index += 1;
			continue;
		}
		output += value[index] ?? "";
		index += 1;
	}
	return output;
}
