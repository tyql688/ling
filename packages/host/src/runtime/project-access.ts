/** Canonical open-project path with an optional lifecycle lease for domain operations. */
export interface ProjectAccess {
	resolveKnownOpenProjectPath(cwd: string): string;
	withKnownOpenProject<T>(cwd: string, operation: (canonicalCwd: string) => Promise<T>): Promise<T>;
}
