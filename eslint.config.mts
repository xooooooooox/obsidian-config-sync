import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'dev',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json', 'vitest.config.ts'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	{
		// src/external is the desktop-only Node adapter layer (child_process, fs, os, path).
		files: ['src/external/**'],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		rules: {
			// Product terms keep their casing in UI copy: "Config Sync", "Sync Center", "Fields mode".
			// "Community" is Obsidian's own settings-tab proper name, quoted in the self-pane advisory button.
			'obsidianmd/ui/sentence-case': ['warn', { ignoreWords: ['Sync', 'Center', 'Fields', 'Community'] }],
		},
	},
);
