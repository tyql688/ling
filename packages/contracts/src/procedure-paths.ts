import { isPortableAbsolutePath, portableAbsolutePathSchema } from "./path-validation";
export interface ProcedurePaths {
	absolute: typeof portableAbsolutePathSchema;
	isAbsolute(value: string): boolean;
	isTildePath(value: string): boolean;
	windows: boolean;
}
/** Browser declarations recognize both OS spellings; the Host supplies its native rules. */
export const portableProcedurePaths: ProcedurePaths = {
	absolute: portableAbsolutePathSchema,
	isAbsolute: isPortableAbsolutePath,
	isTildePath: (value) => value.startsWith("~/") || value.startsWith("~\\"),
	windows: false,
};
