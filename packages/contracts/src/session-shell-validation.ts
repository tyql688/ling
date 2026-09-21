import { safeIdSchema } from "./schema-primitives";
import { sessionRefSchema } from "./session-ref";

export const viewedSessionRefSchema = sessionRefSchema.nullable();

/** Paired dialog and approval ids are UUID-sized; reject oversized callback identities. */
const DIALOG_REQUEST_ID_MAX_CHARS = 128;
export const dialogRequestIdSchema = safeIdSchema(DIALOG_REQUEST_ID_MAX_CHARS, "Dialog request id");
