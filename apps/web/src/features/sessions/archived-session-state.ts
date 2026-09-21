import type { ArchivedTranscript } from "@ling/contracts/session";
import { atom } from "jotai";

/**
 * Transcripts read straight from their session file. A project whose folder was deleted cannot bind
 * a runtime, so its sessions open here instead: the history stays readable and nothing can continue it.
 * A null entry marks the session as archived while its file is still being read, so runtime-bound
 * surfaces never mount for it in between.
 */
export const archivedTranscriptsAtom = atom<ReadonlyMap<string, ArchivedTranscript | null>>(new Map());
