import type { SessionMessage } from "@ling/contracts/session";

export interface ModelRef {
	provider: string;
	modelId: string;
}

function isConversationMessage(message: SessionMessage): boolean {
	return message.role === "user" || message.role === "assistant";
}

export function visibleModelChangeIndexes(messages: readonly SessionMessage[]): Set<number> {
	const visible = new Set<number>();
	let pendingModelChangeIndex: number | null = null;
	let hasConversationBeforeModelChange = false;
	messages.forEach((message, index) => {
		if (message.role === "modelChange") {
			pendingModelChangeIndex = hasConversationBeforeModelChange ? index : null;
			return;
		}
		if (!isConversationMessage(message)) return;
		if (pendingModelChangeIndex !== null) visible.add(pendingModelChangeIndex);
		pendingModelChangeIndex = null;
		hasConversationBeforeModelChange = true;
	});
	return visible;
}

export function previousModelRef(messages: SessionMessage[], modelChangeIndex: number): ModelRef | null {
	for (let index = modelChangeIndex - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "assistant" && message.provider && message.model) {
			return { provider: message.provider, modelId: message.model };
		}
	}
	return null;
}

export function modelRefLabel(model: ModelRef, peer?: ModelRef): string {
	return peer && peer.provider !== model.provider ? `${model.provider}/${model.modelId}` : model.modelId;
}
