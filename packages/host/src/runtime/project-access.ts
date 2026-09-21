/** A canonical open-project path with an optional lifecycle lease. Domains consume this port. */
export interface ProjectAccess {
	resolveKnownOpenProjectPath(cwd: string): string;
	withKnownOpenProject<T>(cwd: string, operation: (canonicalCwd: string) => Promise<T>): Promise<T>;
}
