import type { TerminalTypography } from "./terminal-preferences";
import type { LingApi } from "@ling/contracts/api/ling-api";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { type ITheme, Terminal as XTermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./terminal-font.css";

export function createTerminalEmulator(
	openExternal: LingApi["app"]["openExternal"],
	theme: ITheme,
	onError: (error: unknown) => void,
	typography: TerminalTypography,
) {
	const xterm = new XTermTerminal({
		// Required by the official Unicode 11 addon. Keep proposed access scoped
		// to this xterm instance rather than exposing any renderer capability.
		allowProposedApi: true,
		allowTransparency: true,
		convertEol: false,
		cursorBlink: true,
		cursorStyle: "bar",
		...typography,
		lineHeight: 1.2,
		macOptionIsMeta: false,
		rightClickSelectsWord: true,
		// Bound retained scrollback while keeping recent command output available.
		scrollback: 10_000,
		theme,
	});
	const fitAddon = new FitAddon();
	const searchAddon = new SearchAddon();
	xterm.loadAddon(fitAddon);
	xterm.loadAddon(searchAddon);
	xterm.loadAddon(new Unicode11Addon());
	xterm.unicode.activeVersion = "11";
	xterm.loadAddon(
		new WebLinksAddon((_event, uri) => {
			void openExternal(uri).catch(onError);
		}),
	);
	return { xterm, fitAddon, searchAddon };
}
