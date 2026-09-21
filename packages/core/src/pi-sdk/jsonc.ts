/** Keep this parser byte-compatible with Pi's unexported models.json parser; both apps share the file. */
export function stripJsonComments(input: string): string {
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail: string | undefined) =>
			tail === undefined ? match : tail,
		);
}
