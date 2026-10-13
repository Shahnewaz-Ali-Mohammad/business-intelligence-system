import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceEntry } from './workspace-entry.mjs';
import { decideEntryRoute } from './entry-route.mjs';
function model(scope, needsDataLookup) {
  let calls = 0;
  return { withStructuredOutput() { const index = calls++; return { async invoke() { return index === 0 ? scope : { needsDataLookup }; } }; } };
}
test('hello produces a greeting without any model or database query', async () => {
 const result = await workspaceEntry({ llm: { withStructuredOutput() { throw Error('Unexpected lookup'); } }, message: 'hello', database: 'TicketingDB' });
 assert.equal(result.route, 'greeting'); assert.match(result.narrative, /TicketingDB/);
});
test('weather following database discussion cannot reach tool selection', async () => {
 const result = await workspaceEntry({ llm: model({ inScope: false, isGreetingOrMeta: false }, false), message: 'how is the weather ??', database: 'TicketingDB', history: [{ role: 'assistant', content: '260 matching records.' }] });
 assert.equal(result.route, 'out_of_scope'); assert.doesNotMatch(result.narrative, /260|active customers/);
});
test('capabilities gets conversational reply', async () => {
 assert.equal((await workspaceEntry({ llm: model({ inScope: true, isGreetingOrMeta: true }, false), message: 'what can you help with?', database: 'TicketingDB' })).route, 'greeting');
});
test('real data questions use the database', async () => {
 assert.equal((await workspaceEntry({ llm: model({ inScope: true, isGreetingOrMeta: false }, true), message: 'count open tickets', database: 'TicketingDB' })).route, 'agent');
});
test('greeting with a data question is not swallowed by the fast path', async () => {
 assert.equal((await workspaceEntry({ llm: model({ inScope: true, isGreetingOrMeta: false }, true), message: 'hello, show open tickets', database: 'TicketingDB' })).route, 'agent');
});
test('follow-up chart requests stay in data conversation', async () => {
 assert.equal((await workspaceEntry({ llm: model({ inScope: true, isGreetingOrMeta: false }, true), message: 'show that as a chart', database: 'TicketingDB' })).route, 'agent');
});
test('both workspaces share corroborated route decision', () => {
 assert.equal(decideEntryRoute({ scope: { inScope: false, isGreetingOrMeta: false }, needsData: { needsDataLookup: true } }).route, 'agent');
 assert.equal(decideEntryRoute({ scope: { inScope: true, isGreetingOrMeta: true }, needsData: { needsDataLookup: true } }).route, 'agent');
});
