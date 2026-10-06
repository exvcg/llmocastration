const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const projectRoot = __dirname;
const mcpOutfile = path.join(projectRoot, 'dist/mcp/server.mjs');
const pluginMcpOutfile = path.join(
	projectRoot,
	'plugin/llm-co-op-agent/dist/mcp/server.mjs'
);

const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',
	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd(result => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				if (location) {
					console.error(
						`    ${location.file}:${location.line}:${location.column}:`
					);
				}
			});
			console.log('[watch] build finished');
		});
	}
};

const copyMcpBundleToPlugin = {
	name: 'copy-mcp-bundle-to-plugin',
	setup(build) {
		build.onEnd(result => {
			if (result.errors.length > 0) {
				return;
			}

			fs.mkdirSync(path.dirname(pluginMcpOutfile), { recursive: true });
			fs.copyFileSync(mcpOutfile, pluginMcpOutfile);

			const sourceMap = `${mcpOutfile}.map`;
			if (fs.existsSync(sourceMap)) {
				fs.copyFileSync(sourceMap, `${pluginMcpOutfile}.map`);
			}
		});
	}
};

async function main() {
	const contexts = await Promise.all([
		esbuild.context({
			absWorkingDir: projectRoot,
			entryPoints: [path.join(projectRoot, 'src/extension.ts')],
			bundle: true,
			format: 'cjs',
			minify: production,
			sourcemap: !production,
			sourcesContent: false,
			platform: 'node',
			outfile: path.join(projectRoot, 'dist/extension.js'),
			external: ['vscode'],
			logLevel: 'silent',
			plugins: [esbuildProblemMatcherPlugin]
		}),
		esbuild.context({
			absWorkingDir: projectRoot,
			entryPoints: [path.join(projectRoot, 'src/mcp/server.ts')],
			bundle: true,
			format: 'esm',
			minify: production,
			sourcemap: !production,
			sourcesContent: false,
			platform: 'node',
			outfile: mcpOutfile,
			logLevel: 'silent',
			plugins: [
				esbuildProblemMatcherPlugin,
				copyMcpBundleToPlugin
			]
		})
	]);

	if (watch) {
		await Promise.all(contexts.map(context => context.watch()));
		return;
	}

	await Promise.all(contexts.map(context => context.rebuild()));
	await Promise.all(contexts.map(context => context.dispose()));
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
