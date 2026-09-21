import { interactionAnswerSchema, type Interaction, type InteractionAnswer } from "@ling/contracts/companions";
import { errorMessage } from "@ling/contracts/ling-error";
import { sessionKey, type SessionRef } from "@ling/contracts/session-ref";
import { Button } from "@renderer/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@renderer/components/ui/dialog";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { appModeAtom, appPageAtom } from "@renderer/lib/navigation-state";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { InteractionsContext, useInteractions } from "./interactions-context";
import { useTranslation } from "react-i18next";
import { InteractionForm } from "./interaction-form";

type Draft = InteractionAnswer["answers"];
const draftKey = (id: string) => `ling.interaction.${id}`;
/** A draft survives a renderer reload while its request is still pending in the Host. */
function readDraft(request: Interaction): Draft {
	try {
		const draft = interactionAnswerSchema.shape.answers.safeParse(
			JSON.parse(sessionStorage.getItem(draftKey(request.id)) ?? "null"),
		);
		if (
			draft.success &&
			draft.data.length === request.questions.length &&
			request.questions.every((question) => draft.data.some((answer) => answer.id === question.id))
		)
			return draft.data;
	} catch {
		// A draft from an interrupted write must not obstruct the live request.
	}
	return request.questions.map((question) => ({ id: question.id, selected: [], text: "" }));
}

/** Pending Host questions and approvals; requests not visible inline stay reachable from a global inbox. */
export function InteractionsProvider({ children }: { children: ReactNode }) {
	const api = useDomainApi("interactions");
	const [requests, setRequests] = useState<Interaction[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const [inlineRequests, setInline] = useState<Record<string, string[]>>({});
	const setInlineRequests = useCallback((owner: string, ids: string[]) => {
		setInline((current) => {
			if (JSON.stringify(current[owner] ?? []) === JSON.stringify(ids)) return current;
			const next = { ...current };
			if (ids.length) next[owner] = ids;
			else delete next[owner];
			return next;
		});
	}, []);
	const visibleIds = new Set(Object.values(inlineRequests).flat());
	const elsewhere = requests.filter((request) => !visibleIds.has(request.id));
	useEffect(() => {
		if (requests.length === 0) setOpen(false);
	}, [requests.length]);
	const [drafts, setDrafts] = useState<Record<string, Draft>>({});
	const updateDraft = useCallback((id: string, value: Draft) => {
		setDrafts((current) => ({ ...current, [id]: value }));
		try {
			sessionStorage.setItem(draftKey(id), JSON.stringify(value));
		} catch (failure) {
			setError(errorMessage(failure));
		}
	}, []);
	const clearDraft = useCallback((id: string) => sessionStorage.removeItem(draftKey(id)), []);
	const { t } = useTranslation();
	useEffect(() => {
		let active = true;
		let received = false;
		const accept = (next: Interaction[]) => {
			if (!active) return;
			setDrafts((current) =>
				Object.fromEntries(next.map((request) => [request.id, current[request.id] ?? readDraft(request)])),
			);
			for (const key of Object.keys(sessionStorage)) {
				if (key.startsWith("ling.interaction.") && !next.some((request) => draftKey(request.id) === key))
					sessionStorage.removeItem(key);
			}
			setRequests(next);
			setError(null);
		};
		const unsubscribe = api.onChanged((value) => {
			received = true;
			accept(value);
		});
		void api.list().then(
			(value) => {
				if (!received) accept(value);
			},
			(failure: unknown) => {
				if (active) setError(errorMessage(failure));
			},
		);
		return () => {
			active = false;
			unsubscribe();
		};
	}, [api]);
	return (
		<InteractionsContext value={{ requests, error, drafts, updateDraft, clearDraft, setInlineRequests }}>
			{children}
			{(elsewhere.length > 0 || error) && (
				<Button
					className="fixed right-4 bottom-4 z-40 rounded-control"
					size="sm"
					variant="outline"
					onClick={() => setOpen(true)}
				>
					{t("interactions.pending", { count: elsewhere.length })}
				</Button>
			)}
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="max-h-[85vh] overflow-auto">
					<DialogTitle>{t("interactions.pending", { count: requests.length })}</DialogTitle>
					{error && <p role="alert">{error}</p>}
					{requests.map((request) => (
						<InteractionForm key={request.id} request={request} />
					))}
				</DialogContent>
			</Dialog>
		</InteractionsContext>
	);
}

/** The first pending request of the composer's session, shown above the editor while it is on screen. */
export function ComposerInteractions({ sessionRef }: { sessionRef: SessionRef }) {
	const { requests, error, setInlineRequests } = useInteractions();
	// Settings and full-window pages keep the workspace mounted but hidden; its cards are not on screen then.
	const mode = useAtomValue(appModeAtom);
	const page = useAtomValue(appPageAtom);
	const visible = mode === "workspace" && page === null;
	const element = useRef<HTMLDivElement>(null);
	const owner = useId();
	// Keep the conversation usable while other requests remain available in the global inbox.
	const own = requests.filter((request) => sessionKey(request.ref) === sessionKey(sessionRef)).slice(0, 1);
	const ids = JSON.stringify(own.map((request) => request.id));
	useEffect(() => {
		if (!visible || !element.current) return;
		const observer = new IntersectionObserver(([entry]) =>
			setInlineRequests(owner, entry?.isIntersecting ? (JSON.parse(ids) as string[]) : []),
		);
		observer.observe(element.current);
		return () => {
			observer.disconnect();
			setInlineRequests(owner, []);
		};
	}, [owner, ids, visible, setInlineRequests]);
	if (!own.length && !error) return null;
	return (
		<div ref={element} className="mb-2 flex min-h-0 flex-col gap-2">
			{error && (
				<p role="alert" className="text-xs text-danger">
					{error}
				</p>
			)}
			{own.map((request) => (
				<InteractionForm key={request.id} request={request} />
			))}
		</div>
	);
}
