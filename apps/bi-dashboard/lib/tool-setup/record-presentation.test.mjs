import test from 'node:test';
import assert from 'node:assert/strict';
import {recordNarrative} from './record-presentation.mjs';
test('verified row reports describe the actual population and never invent record details',()=>{
 const text=recordNarrative({rows:[{}],hasMore:false},{population:100},'{"limit":100}');
 assert.match(text,/100 matching records/);assert.match(text,/default record order/);assert.doesNotMatch(text,/cannot display|Customer A/);
 assert.match(recordNarrative({rows:[],hasMore:false},{population:0},'{}'),/^No records/);
 assert.doesNotMatch(recordNarrative({rows:[{}],hasMore:true},null,'{}'),/1 matching/);
});
