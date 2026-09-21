import type { LingApi } from "./api/ling-api";
import type { ShellApi } from "./api/shell-api";

declare global {
	interface Window {
		ling: LingApi;
		lingShell?: ShellApi;
	}
}
