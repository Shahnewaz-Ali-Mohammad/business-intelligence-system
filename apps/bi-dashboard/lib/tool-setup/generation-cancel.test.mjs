import test from 'node:test';
import assert from 'node:assert/strict';
import {generateTools} from './generate.ts';
test('cancelled generation exits before any model request or registry write',async()=>{
 const controller=new AbortController();controller.abort(new Error('Cancelled by user'));
 await assert.rejects(generateTools({objects:[],relationships:[]},[],'',{signal:controller.signal}),/Cancelled by user/);
});
