import {namedKeyLinks} from './named-key-links.mjs';
// Enrich saved physical metadata consistently for generation, approval and MCP.
// The physical schema fingerprint remains unchanged.
export function readCatalog(saved) {
  return namedKeyLinks(typeof saved === 'string' ? JSON.parse(saved) : saved);
}
