import { createElement } from "react";
import type { HostApi } from "@ling/contracts/api/host-procedures";
import { createRoot } from "react-dom/client";
import { HostDirectoryPicker } from "./host-directory-picker";

let activePicker = false;

/** The browser chooses a Host path using the same controls and focus behavior as the application. */
export function chooseBrowserHostDirectory(
	home: string | null,
	browseDirectory: HostApi["project"]["browseDirectories"],
	signal: AbortSignal,
): Promise<string | null> {
	signal.throwIfAborted();
	if (activePicker) return Promise.reject(new Error("A Host directory picker is already open"));
	activePicker = true;
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	return new Promise((resolve) => {
		let settled = false;
		const cancel = () => finish(null);
		const finish = (value: string | null) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", cancel);
			// Unmount after React finishes the event that submitted or dismissed the dialog.
			queueMicrotask(() => {
				root.unmount();
				container.remove();
				activePicker = false;
				resolve(value);
			});
		};
		signal.addEventListener("abort", cancel, { once: true });
		root.render(createElement(HostDirectoryPicker, { home, browseDirectory, onFinish: finish }));
	});
}
