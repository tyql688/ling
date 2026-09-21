/**
 * Upper bound (characters) for absolute path / project cwd / session file path fields.
 * Aligned with common OS PATH_MAX magnitudes; rejects oversized strings so validation, serialization, and corrupt lines can't exhaust memory.
 */
export const ABSOLUTE_PATH_MAX_CHARS = 32_768;

/**
 * Upper bound (characters) for session / entry-style short ids. UUIDs and Pi entry ids are far smaller; used to reject dirty references.
 */
export const SESSION_ID_MAX_CHARS = 1_024;
