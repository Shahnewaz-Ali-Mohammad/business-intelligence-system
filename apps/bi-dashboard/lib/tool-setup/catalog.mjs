import {namedKeyLinks} from './named-key-links.mjs';
import {gzipSync,gunzipSync} from 'node:zlib';
// Keep the JSON column compatible while avoiding small MySQL packet limits.
export function writeCatalog(catalog){
 const json=JSON.stringify(catalog);
 return Buffer.byteLength(json)>256000?JSON.stringify({encoding:'gzip-base64-v1',data:gzipSync(json).toString('base64')}):json;
}
export function readCatalog(saved){
 let catalog=typeof saved==='string'?JSON.parse(saved):saved;
 if(catalog?.encoding==='gzip-base64-v1')catalog=JSON.parse(gunzipSync(Buffer.from(catalog.data,'base64'),{maxOutputLength:32*1024*1024}).toString('utf8'));
 return namedKeyLinks(catalog);
}
