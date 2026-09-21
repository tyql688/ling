import { sharedPreferenceAtom } from "@renderer/lib/user-state/state";
/** "Send shortcut": when Enter sends vs. inserts a newline. */
export type SendShortcut = "enter" | "cmd-enter-multiline" | "cmd-enter-always";
/** What a plain send does while the agent is running. The shortcut modifier inverts it. */
export type FollowUpBehavior = "queue" | "steer";
/** Markdown editing stays opt-in, including after first migration or on a new installation. */
export const composerEditorModeAtom = sharedPreferenceAtom("composerEditorMode", "plain");
export const sendShortcutAtom = sharedPreferenceAtom("sendShortcut", "enter");
export const followUpBehaviorAtom = sharedPreferenceAtom("followUpBehavior", "queue");
