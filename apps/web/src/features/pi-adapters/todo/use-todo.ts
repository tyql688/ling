import { sessionKey, type SessionRef } from "@ling/contracts/session-ref";
import type { TodoSnapshot } from "@ling/contracts/todo";
import { sessionBusyFamily, sessionMessagesFamily } from "@renderer/features/sessions/state/session";
import { useFeatureSnapshot } from "@renderer/features/companions/use-feature-snapshot";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { useAtomValue } from "jotai";
import { useMemo } from "react";

/** The latest rpiv-todo state for a session, reloaded when a new todo result arrives or the turn settles. */
export function useTodo(sessionRef: SessionRef) {
	const api = useDomainApi("todo");
	const key = sessionKey(sessionRef);
	const busy = useAtomValue(sessionBusyFamily(key));
	const messages = useAtomValue(sessionMessagesFamily(key));
	const latestCall = useMemo(
		() => messages.findLast((message) => message.role === "toolResult" && message.toolName === "todo")?.id ?? "",
		[messages],
	);
	const state = useFeatureSnapshot<TodoSnapshot>({
		load: () => api.snapshot(sessionRef),
		subscribe: () => () => undefined,
		key,
		revision: `${latestCall}\0${busy}`,
	});
	return { ...state, sessionBusy: busy };
}
