/** Command actions supplied by the workspace shell. */
export interface SlashCommandContext {
	renameSession(title: string): Promise<void>;
	compactSession(customInstructions?: string): Promise<void>;
	inspectSession?(): void;
	reloadResources?(): Promise<void>;
}

export interface SlashCommandDefinition {
	/** Pi command name used in the CLI. */
	name: string;
	needsArg: boolean;
	/** i18n key for the one-line description in the popover. */
	descriptionKey: string;
	run(context: SlashCommandContext, arg: string): void | Promise<void>;
}

/**
 * Host-level `/` command registry: only commands that take an argument or have no one-click
 * alternative are included. Popover matching, composer submission, and Enter handling all
 * read this table.
 */
export const SLASH_COMMANDS: readonly SlashCommandDefinition[] = [
	{
		name: "session",
		needsArg: false,
		descriptionKey: "sessionInspector.description",
		run: (context) => context.inspectSession?.(),
	},
	{
		name: "reload",
		needsArg: false,
		descriptionKey: "session.cmdReloadDesc",
		run: (context) => context.reloadResources?.(),
	},
	{
		name: "name",
		needsArg: true,
		descriptionKey: "session.cmdNameDesc",
		run: (context, arg) => context.renameSession(arg),
	},
	{
		name: "compact",
		needsArg: false,
		descriptionKey: "session.cmdCompactDesc",
		run: (context, arg) => context.compactSession(arg || undefined),
	},
];

export function findSlashCommand(name: string): SlashCommandDefinition | undefined {
	return SLASH_COMMANDS.find((command) => command.name === name);
}
