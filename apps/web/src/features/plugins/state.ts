import type { AgentInfo } from "@ling/contracts/application";
import type { ConfiguredPackage, PluginProgressEvent, PluginUpdateInfo } from "@ling/contracts/plugin";
import { atom } from "jotai";

export const agentInfoAtom = atom<AgentInfo | null>(null);
export const configuredPackagesAtom = atom<ConfiguredPackage[]>([]);
export const availableUpdatesAtom = atom<PluginUpdateInfo[]>([]);
export const checkingUpdatesAtom = atom(false);
export const pluginsBusyAtom = atom(false);
export const progressLogAtom = atom<PluginProgressEvent[]>([]);
export const pluginsErrorAtom = atom<Error | null>(null);
