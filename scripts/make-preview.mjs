import {build} from 'vite';
import react from '@vitejs/plugin-react';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {renderToString} from 'react-dom/server';
import {createElement} from 'react';
import assert from 'node:assert/strict';

const root=resolve(import.meta.dirname,'..');
const common={configFile:false,root,logLevel:'warn',resolve:{alias:{'@':root}}};
// Real React output gives the file an initial rendered view even in readers
// that choose not to execute scripts. The IIFE adds local interactivity.
await build({...common,plugins:[react()],build:{ssr:resolve(root,'components/own-page.tsx'),outDir:resolve(root,'.preview-build/ssr'),emptyOutDir:true,rollupOptions:{output:{entryFileNames:'page.mjs'}}}});
const {default:Page}=await import(pathToFileURL(resolve(root,'.preview-build/ssr/page.mjs')).href);
const markup=renderToString(createElement(Page));
const ids=[...markup.matchAll(/data-slot-id="(\d+)"/g)].map(m=>Number(m[1]));
assert.equal(ids.length,62,'Render all62 placements');assert.equal(new Set(ids).size,62,'No duplicate slot IDs');
assert.deepEqual([...ids].sort((a,b)=>a-b),Array.from({length:62},(_,i)=>i));
assert(markup.includes('https://x.com/ownthispage'),'Owner-approved official X account');
assert.equal((markup.match(/data-official="/g)||[]).length,2,'Fixed official CA and X remain separate');
await build({...common,plugins:[react()],define:{'process.env.NODE_ENV':'"production"'},build:{target:'es2022',outDir:resolve(root,'.preview-build/browser'),emptyOutDir:true,cssCodeSplit:false,lib:{entry:resolve(root,'main.tsx'),name:'OwnThisPagePreview',formats:['iife'],fileName:()=> 'app.js'},rollupOptions:{output:{inlineDynamicImports:true}}}});
const logo='data:image/png;base64,'+(await readFile(resolve(root,'public/brand/own-this-page-logo.png'))).toString('base64');
const script=(await readFile(resolve(root,'.preview-build/browser/app.js'),'utf8')).replaceAll('./brand/own-this-page-logo.png',logo).replaceAll('</script','<\\/script');
const css=await readFile(resolve(root,'.preview-build/browser/own-this-page.css'),'utf8');
const config=JSON.parse(await readFile(resolve(root,'public/market-config.json'),'utf8'));
assert.equal(config.enabled,false);assert.equal(config.mint,'');assert.equal(config.programId,'');
const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Own This Page — Unpublished preview</title><link rel="icon" href="${logo}"><style>${css}</style></head><body><div id="root">${markup.replaceAll('./brand/own-this-page-logo.png',logo)}</div><script type="application/json" id="own-page-preview-config">${JSON.stringify(config).replaceAll('<','\\u003c')}</script><script>${script}</script></body></html>`;
await mkdir(resolve(root,'deliverables'),{recursive:true});
await writeFile(resolve(root,'deliverables/own-this-page-preview.html'),html);
await writeFile(resolve(root,'deliverables/validation.json'),JSON.stringify({slotCount:ids.length,uniqueIds:new Set(ids).size,minimumId:Math.min(...ids),maximumId:Math.max(...ids),officialPanels:2,officialX:'https://x.com/ownthispage',previewPaymentsEnabled:false},null,2)+'\n');
console.log('Portable preview saved. All62 unique slot IDs rendered; official CA and X are protected. No external hosting or RPC calls.');
