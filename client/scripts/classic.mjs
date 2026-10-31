import { readFile, writeFile } from 'node:fs/promises';
const file = new URL('../dist/index.html', import.meta.url);
let html = await readFile(file, 'utf8');
html = html.replace(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"[^>]*><\/script>/i,
  (_all, src) => `<script defer src="${src}"></script>`);
if (process.argv[2] === 'webos') {
  html = html.replace(/<body\b([^>]*)>/i, (_all, attrs) => {
    const withClientClass = attrs.replace(/\bclass="([^"]*)"/i, (_class, value) => `class="${value} webos-client"`);
    return `<body${withClientClass}>`;
  });
}
await writeFile(file, html);
