import Ansi from "ansi-to-react";
import { projectExtensionTerminalText } from "./extension-terminal-text";

export function TerminalText({ value }: { value: string }) {
	return <Ansi useClasses>{projectExtensionTerminalText(value)}</Ansi>;
}
