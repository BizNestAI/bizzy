import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');

test('every newly received assistant response is explicitly marked for animation', () => {
  const hook = read('src/hooks/useBizzyChat.js');

  assert.match(hook, /sender: 'assistant',[\s\S]*animateOnArrival: true/);
});

test('scripted fast replies bypass thread-open timing guards without replaying later', () => {
  const canvas = read('src/components/Bizzy/ChatCanvas.jsx');

  assert.match(canvas, /m\.animateOnArrival === true && !arrivalAnimationDoneRef\.current\.has\(key\)/);
  assert.match(
    canvas,
    /explicitlyFresh \|\|\s*\(!alreadyAnimated && !reopenBlockRef\.current && !threadJustOpenedRef\.current\)/
  );
  assert.match(canvas, /arrivalAnimationDoneRef\.current\.add\(key\)/);
});

test('fresh replies override the new-thread premark that previously made onboarding answers static', () => {
  const canvas = read('src/components/Bizzy/ChatCanvas.jsx');
  const animationDecision = canvas.match(/const shouldAnimate =([\s\S]*?);\n\s*if \(shouldAnimate\)/)?.[1] || '';

  assert.match(animationDecision, /explicitlyFresh \|\|/);
  assert.doesNotMatch(animationDecision, /!alreadyAnimated &&\s*\(\s*explicitlyFresh/);
});

test('typewriter uses frame-paced character bursts with punctuation pauses and reduced-motion support', () => {
  const canvas = read('src/components/Bizzy/ChatCanvas.jsx');

  assert.match(canvas, /requestAnimationFrame\(loop\)/);
  assert.match(canvas, /revealCost\(textRef\.current\[iRef\.current\]\)/);
  assert.match(canvas, /PUNCTUATION_COST/);
  assert.match(canvas, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(canvas, /function chunkWords/);
});
