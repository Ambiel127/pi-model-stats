import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{ ignores: ["node_modules/**", ".test-agent/**"] },
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ["src/**/*.ts", "test/**/*.ts"],
		languageOptions: {
			globals: {
				Buffer: "readonly",
				process: "readonly",
			},
		},
		rules: {
			"@typescript-eslint/no-explicit-any": "off",
			"no-control-regex": "off",
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
		},
	},
);
