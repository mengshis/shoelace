//
// Builds the project. To spin up a dev server, pass the --serve flag.
//
import browserSync from 'browser-sync';
import chalk from 'chalk';
import commandLineArgs from 'command-line-args';
import copy from 'recursive-copy';
import del from 'del';
import esbuild from 'esbuild';
import { execSync } from 'child_process';
import getPort from 'get-port';
import glob from 'globby';
import inlineImportPlugin from 'esbuild-plugin-inline-import';
import path from 'path';
import sass from 'sass';
import sassPlugin from 'esbuild-plugin-sass';

const build = esbuild.build;
const bs = browserSync.create();
const { dev } = commandLineArgs({ name: 'dev', type: Boolean });

del.sync('./dist');

if (!dev) execSync('tsc', { stdio: 'inherit' }); // for type declarations
execSync('node scripts/make-metadata.js', { stdio: 'inherit' });
execSync('node scripts/make-icons.js', { stdio: 'inherit' });

(async () => {
  const entryPoints = [
    // The whole shebang dist
    './src/shoelace.ts',
    // Components
    ...(await glob('./src/components/**/!(*.test).ts')),
    // Public utilities
    ...(await glob('./src/utilities/**/!(*.test).ts')),
    // Theme stylesheets
    ...(await glob('./src/themes/**/!(*.test).ts'))
  ];

  const buildResult = await esbuild
    .build({
      format: 'esm',
      target: 'es2017',
      entryPoints,
      outdir: './dist',
      chunkNames: 'chunks/[name].[hash]',
      incremental: dev,
      define: {
        // Popper.js expects this to be set
        'process.env.NODE_ENV': '"production"'
      },
      bundle: true,
      splitting: true,
      plugins: [
        // Run inline style imports through Sass
        inlineImportPlugin({
          filter: /^sass:/,
          transform: async (contents, args) => {
            return await new Promise((resolve, reject) => {
              sass.render(
                {
                  data: contents,
                  includePaths: [path.dirname(args.path)]
                },
                (err, result) => {
                  if (err) {
                    reject(err);
                    return;
                  }

                  resolve(result.css.toString());
                }
              );
            });
          }
        }),
        // Run all other stylesheets through Sass
        sassPlugin()
      ]
    })
    .catch(err => {
      console.error(chalk.red(err));
      process.exit(1);
    });

  // Create the docs distribution by copying dist into docs/dist. This is what powers the website. It can't exist in dev
  // because it will conflict with browser sync's routing to the actual dist dir.
  await del('./docs/dist');
  if (!dev) {
    await copy('./dist', './docs/dist');
  }

  console.log(chalk.green('The build has finished! 📦'));

  if (dev) {
    const port = await getPort({
      port: getPort.makeRange(4000, 4999)
    });

    console.log(chalk.cyan(`\nLaunching the Shoelace dev server at http://localhost:${port}! 🥾\n`));

    // Launch browser sync
    bs.init({
      startPath: '/',
      port,
      logLevel: 'silent',
      logPrefix: '[shoelace]',
      logFileChanges: true,
      notify: false,
      server: {
        baseDir: 'docs',
        routes: {
          '/dist': './dist'
        }
      }
    });

    // Rebuild and reload when source files change
    bs.watch(['src/**/!(*.test).*']).on('change', async filename => {
      console.log(`Source file changed - ${filename}`);

      // NOTE: we don't run TypeDoc on every change because it's quite heavy, so changes to the docs won't be included
      // until the next time the build script runs.
      buildResult
        .rebuild()
        .then(() => bs.reload())
        .catch(err => console.error(chalk.red(err)));
    });

    // Reload without rebuilding when the docs change
    bs.watch(['docs/**/*']).on('change', filename => {
      console.log(`Docs file changed - ${filename}`);
      bs.reload();
    });

    // Cleanup on exit
    process.on('SIGTERM', () => buildResult.rebuild.dispose());
  }
})();
