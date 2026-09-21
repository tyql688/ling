import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import jsxA11y from "eslint-plugin-jsx-a11y";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: [
			"**/out/**",
			"**/dist/**",
			"release/**",
			"output/**",
			"resources/**",
			"apps/web/public/**",
			"apps/desktop/.stage/**",
			"apps/desktop/build/**",
			"apps/desktop/artifacts/**",
			"tmpcode/**",
			".playwright-cli/**",
		],
	},

	// Config files and build scripts: no type-aware rules, Node globals.
	{
		files: ["**/*.{js,mjs,cjs}"],
		extends: [js.configs.recommended],
		languageOptions: {
			ecmaVersion: "latest",
			sourceType: "module",
			globals: { process: "readonly", console: "readonly", URL: "readonly" },
		},
	},

	// Stale suppressions fail instead of silently accumulating.
	{ linterOptions: { reportUnusedDisableDirectives: "error" } },

	{
		files: ["**/*.{ts,tsx}"],
		extends: [js.configs.recommended, ...tseslint.configs.recommended],
		languageOptions: {
			// ESLint reads TS 6; the separate @typescript/native compiler runs TS 7.
			parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
		},
		rules: {
			// `== null` is the deliberate "null or undefined" test; every other loose comparison coerces.
			eqeqeq: ["error", "always", { null: "ignore" }],
			// `_`-prefixed bindings are deliberate discards.
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
					destructuredArrayIgnorePattern: "^_",
				},
			],
			"@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
			// `let x!: T` that a closure reads before the assignment is a deliberate mutual reference
			// (a record and the delivery object that calls back into it); const would reorder them.
			"prefer-const": ["error", { ignoreReadBeforeAssign: true }],

			// Deliberate fire-and-forget uses `void`; other unhandled promises fail.
			"@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true }],
			"@typescript-eslint/await-thenable": "error",
			// Async callbacks must not hide rejected promises behind a void return type.
			"@typescript-eslint/no-misused-promises": "error",
			// A growing union breaks uncovered switches; an explicit default remains exhaustive.
			"@typescript-eslint/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: true }],
			// Error text must not stringify an object as "[object Object]".
			"@typescript-eslint/no-base-to-string": "error",
			"@typescript-eslint/no-import-type-side-effects": "error",
			// SDK upgrades must surface deprecated calls.
			"@typescript-eslint/no-deprecated": "error",
			"@typescript-eslint/no-unnecessary-type-assertion": "error",
			"@typescript-eslint/no-duplicate-type-constituents": "error",
			"@typescript-eslint/no-redundant-type-constituents": "error",
			"@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
			// Preserve caught errors while rejecting literal throws.
			"@typescript-eslint/only-throw-error": ["error", { allowThrowingAny: true, allowThrowingUnknown: true }],
			"@typescript-eslint/prefer-promise-reject-errors": [
				"error",
				{ allowThrowingAny: true, allowThrowingUnknown: true },
			],
		},
	},

	// Hooks live in .ts files too (the feature-owned use-*.ts), so hook rules cover both.
	{
		files: ["apps/web/**/*.{ts,tsx}"],
		plugins: { "react-hooks": reactHooks },
		rules: {
			// Compiler migration rules are excluded until the app adopts React Compiler.
			"react-hooks/rules-of-hooks": "error",

			// Deliberate dependency exceptions must be explained at the affected hook.
			"react-hooks/exhaustive-deps": "error",
		},
	},

	// JSX-only surfaces.
	{
		files: ["apps/web/**/*.tsx"],
		extends: [react.configs.flat.recommended, jsxA11y.flatConfigs.recommended],
		settings: { react: { version: "detect" } },
		plugins: { "react-refresh": reactRefresh },
		rules: {
			// The automatic JSX runtime needs neither the React import nor prop-types.
			"react/react-in-jsx-scope": "off",
			"react/prop-types": "off",
			"react/no-array-index-key": "error",
			// Component-only modules retain Fast Refresh without losing UI state.
			"react-refresh/only-export-components": ["error", { allowConstantExport: true }],
		},
	},

	// Formatting belongs to Prettier; disable any conflicting preset rules last.
	prettier,
);
