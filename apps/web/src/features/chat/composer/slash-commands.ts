/** Everything a command may do — provided by the workspace shell. */
export interface SlashCommandContext {
	renameSession(title: string): void;
	compactSession(): void;
}

export interface SlashCommandDefinition {
	/** pi's command name — Ling keeps the CLI vocabulary. */
	name: string;
	needsArg: boolean;
	/** i18n key for the one-line description in the popover. */
	descriptionKey: string;
	run(context: SlashCommandContext, arg: string): void;
}

/**
 * Host-level `/` command registry: only commands that take an argument or have no one-click
 * alternative are included. Popover matching, composer submission, and Enter handling all
 * read this table.
 */
export const SLASH_COMMANDS: readonly SlashCommandDefinition[] = [
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
		run: (context) => context.compactSession(),
	},
];

export function findSlashCommand(name: string): SlashCommandDefinition | undefined {
	return SLASH_COMMANDS.find((command) => command.name === name);
}
