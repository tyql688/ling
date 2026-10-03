import { z } from "zod";
import { pathStringSchema, portableAbsolutePathSchema } from "./path-validation";

export const PERMISSION_PACKAGE = "@gotgenes/pi-permission-system";
export const permissionSourceSchema = z.enum(["bundled", "external", "none"]);
export type PermissionSource = z.infer<typeof permissionSourceSchema>;

/** Which projects load Ling's bundled permission package. Installed Pi packages retain their own switches. */
export const accessActivationSchema = z.strictObject({
	revision: z.number().int().nonnegative(),
	defaultEnabled: z.boolean(),
	projects: z.record(pathStringSchema("Project path"), z.boolean()),
});
export type AccessActivation = z.infer<typeof accessActivationSchema>;
export const accessActivationUpdateSchema = z.strictObject({
	expectedRevision: z.number().int().nonnegative(),
	defaultEnabled: z.boolean().optional(),
	project: z
		.strictObject({ cwd: portableAbsolutePathSchema("Project path"), enabled: z.boolean().nullable() })
		.optional(),
});
export type AccessActivationUpdate = z.infer<typeof accessActivationUpdateSchema>;

export type AccessChoice = "full" | "global" | "project";
export function accessChoice(state: AccessActivation, cwd: string | null): AccessChoice {
	const project = cwd ? state.projects[cwd] : undefined;
	if (!(project ?? state.defaultEnabled)) return "full";
	return project === true ? "project" : "global";
}
export function accessEnabled(state: Pick<AccessActivation, "defaultEnabled" | "projects">, cwd: string): boolean {
	return state.projects[cwd] ?? state.defaultEnabled;
}
