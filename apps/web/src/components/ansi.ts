import RawAnsi from "ansi-to-react";

// ansi-to-react publishes a transpiled CommonJS default. Rolldown follows Node's
// namespace semantics in ESM packages; its optimizer can still unwrap the default.
const exported: unknown = RawAnsi;
export const Ansi =
	typeof exported === "object" && exported !== null && "default" in exported
		? (exported.default as typeof RawAnsi)
		: RawAnsi;
