import test from 'node:test';
import assert from 'node:assert/strict';
import { writeAnalyticalInsight, groundedNarrative } from './analytical-insight.mjs';
const summary = { population: '2001', scope: 'full matching records', numeric: [{ title: 'Amount', statistics: { average: '1001', median: '1001', minimum: '1', maximum: '2001', missing: '0' } }] };
test('AI receives full statistics, not record previews', async () => {
  const text = await writeAnalyticalInsight({ question: 'Explain the amounts', summary }, async (messages) => {
    const facts = JSON.parse(messages[1].content);
    assert.deepEqual(facts.summary, summary);
    assert.equal(facts.preview, undefined);
    assert.match(messages[0].content, /average versus median/);
    return { narrative: 'Amounts have an average and median of 1,001.' };
  });
  assert.match(text, /average and median/);
});
test('AI failure returns verified statistics instead of a basic table sentence', async () => {
  const text = await writeAnalyticalInsight({ question: 'Explain', summary }, async () => { throw new Error('Unavailable'); });
  assert.match(text, /average 1,001, median 1,001, lowest 1, highest 2,001/);
  assert.match(text, /AI wording is unavailable/);
});
test('identifier group insights distinguish missing and empty labels from complete counts', async () => {
  const groups = { scope: 'matching result groups', population: '2', numeric: [{ title: 'ticket count', statistics: { minimum: '12', maximum: '173046', missing: '0' }, highestGroups: [{ labels: { LinkId: null }, value: '173046' }], lowestGroups: [{ labels: { LinkId: '' }, value: '12' }] }] };
  const text = await writeAnalyticalInsight({ question: 'Count by LinkId', summary: groups }, async (messages) => {
    assert.match(JSON.parse(messages[1].content).groupLabelMeaning, /different groups/);
    throw new Error('Unavailable');
  });
  assert.match(text, /Missing \(NULL\) has the highest ticket count, 173,046/);
  assert.match(text, /Empty string has the lowest, 12/);
});
test('fallback category and date summaries use readable warehouse column titles', async () => {
  const text = await writeAnalyticalInsight({ question: 'Explain', summary: { ...summary, categories: [{ member: 'w_t.f_status_hash', title: 'Status', breakdown: { highest: [{ label: 'Open', count: '2', percentage: '100' }], lowest: [{ label: 'Open', count: '2' }] } }], dates: [{ member: 'w_t.f_date_hash', title: 'CreatedAt', earliest: '2025-01-01', latest: '2025-01-02' }] } }, async () => { throw new Error('Unavailable'); });
  assert.match(text, /Status: Open/); assert.match(text, /CreatedAt ranges/); assert.ok(!text.includes('hash'));
});
test('unspecified currency is rejected instead of attached to numeric data', async () => {
  const text = await writeAnalyticalInsight({ question: 'Explain Amount', summary }, async () => ({ narrative: 'The average is BDT 1001.' }));
  assert.ok(!text.includes('BDT'));
  assert.match(text, /verified database statistics/);
  const currencyText = await writeAnalyticalInsight({ question: 'Explain billing', summary, currency: 'BDT' }, async () => ({ narrative: 'The average is BDT 1001.' }));
  assert.match(currencyText, /BDT/);
});
test('equal mean and median do not prove symmetry or skew', () => {
  assert.equal(groundedNarrative('The average and median are 1001, indicating a symmetrical distribution. The minimum is 1.', summary), 'The average and median are 1001. The minimum is 1.');
  assert.throws(() => groundedNarrative('Since there is only one record, the average is 1001.', { scope: 'matching result groups' }), /group/);
});
test('category completeness cannot be inferred from non-missing measures', () => {
  const sentence = 'There are no missing category values in this dataset.';
  assert.throws(() => groundedNarrative(sentence, summary), /grouping coverage/);
  assert.throws(() => groundedNarrative(sentence, { ...summary, grouping: [{ title: 'OfficeCat', missingGroups: 1, emptyGroups: 0 }] }), /grouping coverage/);
  assert.equal(groundedNarrative(sentence, { ...summary, grouping: [{ title: 'OfficeCat', missingGroups: 0, emptyGroups: 0 }] }), sentence);
});
test('single aggregate answers do not mistake one result for one source row', async () => {
  const text = await writeAnalyticalInsight({ question: 'How many tickets?', summary: { scope: 'matching result groups', population: '1', numeric: [{ title: 'Tickets record count', statistics: { minimum: '2001' } }] } }, async () => { throw new Error('Should not require an AI call'); });
  assert.equal(text, 'Tickets record count: 2,001.');
});
test('specific records answer with their actual fields, not single-row averages', async () => {
  const text = await writeAnalyticalInsight({ question: 'Ticket 0001 details', summary, records: [{ TicketId: '0001', Amount: '1', Status: 'Open', LinkId: null }] }, async () => { throw new Error('No AI call needed for exact details'); });
  assert.equal(text, 'TicketId: 0001; Amount: 1; Status: Open; LinkId: not available.');
  assert.ok(!/average|median|100%/.test(text));
});

test('insights publish checked sentences while the model is still generating', async () => {
  const received = [];
  const text = await writeAnalyticalInsight({ question: 'Explain', summary, onText: (text) => received.push(text) }, undefined, async function* (messages) {
    assert.deepEqual(JSON.parse(messages[1].content).summary, summary);
    yield { narrative: 'The average is 1,001' };
    assert.equal(received.length, 0);
    yield { narrative: 'The average is 1,001. The minimum' };
    assert.deepEqual(received, ['The average is 1,001.']);
    yield { narrative: 'The average is 1,001. The minimum is 1.' };
  });
  assert.equal(text, 'The average is 1,001. The minimum is 1.');
});
test('unsafe streaming wording falls back without exposing the rejected sentence', async () => {
  const received = [];
  const text = await writeAnalyticalInsight({ question: 'Explain', summary, onText: (text) => received.push(text) }, undefined, async function* () {
    yield { narrative: 'The average is BDT 1,001. Next' };
  });
  assert.deepEqual(received, []);
  assert.match(text, /verified database statistics/);
});
test('cancelled insight generation does not manufacture a fallback answer', async () => {
  const controller = new AbortController();
  controller.abort(new Error('Cancelled'));
  await assert.rejects(writeAnalyticalInsight({ question: 'Explain', summary, signal: controller.signal, onText() {} }, undefined, async function* () { throw new Error('Cancelled'); }), /Cancelled/);
});
