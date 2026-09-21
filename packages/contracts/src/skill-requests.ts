import { SKILL_EXTRA_PATH_MAX_CHARS, SKILL_RESOURCE_RELATIVE_PATH_MAX_CHARS } from "./skill";
import { boundedString, strictObject } from "./schema-primitives";
import { z } from "zod";
export const skillFilePathSchema = strictObject({
	filePath: boundedString(SKILL_EXTRA_PATH_MAX_CHARS, "Skill file path"),
});

export const skillResourceRequestSchema = strictObject({
	filePath: boundedString(SKILL_EXTRA_PATH_MAX_CHARS, "Skill file path"),
	relativePath: boundedString(SKILL_RESOURCE_RELATIVE_PATH_MAX_CHARS, "Skill resource path"),
});

export const skillPathRequestSchema = strictObject({
	path: boundedString(SKILL_EXTRA_PATH_MAX_CHARS, "Skill directory path"),
});

export const skillProjectRequestSchema = strictObject({
	cwd: boundedString(SKILL_EXTRA_PATH_MAX_CHARS, "Project path"),
});

export const builtinMasterRequestSchema = strictObject({
	enabled: z.boolean(),
});

// 64 chars is the Agent Skills spec's skill-name bound.
export const skillEnabledRequestSchema = strictObject({
	name: boundedString(64, "Skill name"),
	enabled: z.boolean(),
});

// Names become `skills add --skill` argv, so only the CLI's own skill-name alphabet passes.
export const skillUpdateRunSchema = strictObject({
	names: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "Invalid skill name")).max(256),
});
