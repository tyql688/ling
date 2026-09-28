import { Ansi } from "@renderer/components/ansi";
import { projectExtensionTerminalText } from "./extension-terminal-text";

export function TerminalText({ value }: { value: string }) {
	return <Ansi useClasses>{projectExtensionTerminalText(value)}</Ansi>;
}
