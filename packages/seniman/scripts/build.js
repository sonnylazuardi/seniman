import fs from 'fs';
import { execa } from 'execa';
import uglifyjs from 'uglify-js';
import zlib from 'zlib';

async function buildClientScaffolding(config) {

  let targetDirectory = config.targetDirectory;

  await fs.promises.mkdir(targetDirectory, { recursive: true });

  let jsCode = await fs.promises.readFile(process.cwd() + '/frontend/browser.js');

  let jsCodeString = jsCode.toString();
  var options = {
    toplevel: true,
    output: {
      beautify: false
    }
  };

  let minifiedCode = uglifyjs.minify(jsCodeString, options).code;
  let htmlString = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1" /><script>${minifiedCode}</script>`;
  let htmlBuffer = Buffer.from(htmlString);


  let frontendBundlePath = targetDirectory + '/frontend-bundle';

  await fs.promises.mkdir(frontendBundlePath, { recursive: true });

  let brotliBuffer = zlib.brotliCompressSync(htmlBuffer);
  await fs.promises.writeFile(frontendBundlePath + '/index.html.brotli', brotliBuffer);

  let gzipBuffer = zlib.gzipSync(htmlBuffer);
  await fs.promises.writeFile(frontendBundlePath + '/index.html.gz', gzipBuffer);

  await fs.promises.writeFile(frontendBundlePath + '/index.html', htmlBuffer);
}


await buildClientScaffolding({
  targetDirectory: process.cwd() + '/dist'
});

// run child process for babel
await execa('./node_modules/.bin/babel', [
  'src',
  '--out-dir',
  './dist'
], {
  stdio: 'inherit'
});
