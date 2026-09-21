import {
	HOST_SHELL_EVENT_CHANNEL,
	HOST_SHELL_STATE_METHOD,
	type HostNotificationKind,
	type HostShellEvent,
	type HostShellState,
} from "@ling/contracts/host-shell";
import type { SessionRef } from "@ling/contracts/session";
import { sessionKey } from "@ling/contracts/session-ref";
import type { AppSettingsSnapshot } from "@ling/contracts/application";
import type { HostClientState } from "./client-state";
import type { HostEventPublisher } from "./event-bus";
import type { HostHandle } from "./request-router";

export interface HostShellActivity {
	agentRunState(ref: SessionRef, running: boolean): void;
	notify(ref: SessionRef, kind: HostNotificationKind, title: string, body: string): void;
	refreshPreferences(): void;
	dispose(): void;
}

interface CreateHostShellActivityOptions {
	readPreferences(): AppSettingsSnapshot;
	clients: HostClientState;
	events: HostEventPublisher;
	handle: HostHandle;
	onShellEvent?(event: HostShellEvent): void;
}

const NOTIFICATION_SETTING = {
	backgroundCompletion: "notifyBackgroundCompletion",
	attentionNeeded: "notifyAttentionNeeded",
} as const;

export function createHostShellActivity(options: CreateHostShellActivityOptions): HostShellActivity {
	const runningRefs = new Map<string, SessionRef>();
	let keepAwakeEnabled = options.readPreferences().keepAwakeWhileRunning;
	let keepRunningEnabled = options.readPreferences().keepRunningOnWindowClose;
	let softwareRendering = options.readPreferences().disableHardwareAcceleration;
	const deliver = (ref: SessionRef | null, event: HostShellEvent): void => {
		options.onShellEvent?.(event);
		if (ref === null) options.events.broadcast(HOST_SHELL_EVENT_CHANNEL, event);
		else {
			const owner = options.clients.ownerOfSession(ref);
			if (owner !== null) options.events.send(owner, HOST_SHELL_EVENT_CHANNEL, event);
		}
	};
	options.handle(HOST_SHELL_STATE_METHOD, async (): Promise<HostShellState> => ({
		keepAwakeEnabled,
		keepRunningEnabled,
		runningRefs: [...runningRefs.values()].map((ref) => ({ ...ref })),
	}));
	deliver(null, { type: "keepAwakePreference", enabled: keepAwakeEnabled });
	deliver(null, { type: "keepRunningPreference", enabled: keepRunningEnabled });
	deliver(null, { type: "graphicsPreference", softwareRendering });
	return {
		agentRunState: (ref, running) => {
			const key = sessionKey(ref);
			if (running) runningRefs.set(key, { ...ref });
			else runningRefs.delete(key);
			deliver(ref, { type: "agentRunState", ref, running });
		},
		notify: (ref, kind, title, body) => {
			const settings = options.readPreferences();
			if (!settings[NOTIFICATION_SETTING[kind]]) return;
			deliver(ref, {
				type: "notification",
				ref,
				title,
				body,
				silent: !settings.playNotificationSounds,
				kind,
			});
		},
		refreshPreferences: () => {
			const settings = options.readPreferences();
			if (settings.keepAwakeWhileRunning !== keepAwakeEnabled) {
				keepAwakeEnabled = settings.keepAwakeWhileRunning;
				deliver(null, { type: "keepAwakePreference", enabled: keepAwakeEnabled });
			}
			if (settings.keepRunningOnWindowClose !== keepRunningEnabled) {
				keepRunningEnabled = settings.keepRunningOnWindowClose;
				deliver(null, { type: "keepRunningPreference", enabled: keepRunningEnabled });
			}
			if (settings.disableHardwareAcceleration !== softwareRendering) {
				softwareRendering = settings.disableHardwareAcceleration;
				deliver(null, { type: "graphicsPreference", softwareRendering });
			}
		},
		dispose: () => {
			for (const ref of runningRefs.values()) deliver(ref, { type: "agentRunState", ref, running: false });
			runningRefs.clear();
		},
	};
}
