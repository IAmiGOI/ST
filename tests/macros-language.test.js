import test from 'node:test';
import assert from 'node:assert/strict';
import {
    tokenize, parse, run, execute,
    MacroSyntaxError, MacroRuntimeError, MacroTimeoutError,
} from '../modules/macros/language.js';

function exec(source, options) {
    const result = execute(source, options);
    if (!result.ok) throw result.error;
    return result.value;
}

// --- Basic values, arithmetic, coercion ---

test('numbers, strings, and arithmetic', () => {
    assert.equal(exec('return 1 + 2'), '3');
    assert.equal(exec('return 2 * 3 + 1'), '7', 'standard precedence: * before +');
    assert.equal(exec('return (2 + 3) * 4'), '20', 'parentheses override precedence');
    assert.equal(exec('return 10 - 3 - 2'), '5', 'left-associative');
    assert.equal(exec('return 7 mod 3'), '1');
    assert.equal(exec('return -5 + 2'), '-3');
});

test('+ concatenates when either side is not numeric, otherwise adds', () => {
    assert.equal(exec('return "a" + "b"'), 'ab');
    assert.equal(exec('return "x=" + 5'), 'x=5');
    assert.equal(exec('return 2 + 3'), '5', 'both numeric — real addition, not concatenation');
});

test('- * / mod require both sides numeric and throw a clear error otherwise', () => {
    assert.throws(() => exec('return "a" - 1'), MacroRuntimeError);
    assert.throws(() => exec('return "a" * 1'), MacroRuntimeError);
    assert.throws(() => exec('return 1 / "a"'), MacroRuntimeError);
});

test('division and mod by zero throw a clear runtime error, not Infinity/NaN', () => {
    assert.throws(() => exec('return 1 / 0'), /division by zero/);
    assert.throws(() => exec('return 1 mod 0'), /division by zero/);
});

test('numeric strings coerce for arithmetic (values read via get() are always strings)', () => {
    assert.equal(exec('set x to "5"\nset y to "3"\nreturn x - y'), '2');
});

// --- Variables ---

test('set stores a variable; reading an undeclared variable is an empty string, not an error', () => {
    assert.equal(exec('set x to 5\nreturn x'), '5');
    assert.equal(exec('return undeclared'), '');
});

// --- Comparisons and logic ---

test('comparison operators', () => {
    assert.equal(exec('if 5 > 3 then\nreturn "yes"\nend\nreturn "no"'), 'yes');
    assert.equal(exec('if 5 < 3 then\nreturn "yes"\nend\nreturn "no"'), 'no');
    assert.equal(exec('if 5 >= 5 then\nreturn "yes"\nend\nreturn "no"'), 'yes');
    assert.equal(exec('if 5 <= 4 then\nreturn "yes"\nend\nreturn "no"'), 'no');
});

test('"is" / "is not" compare numerically when possible, otherwise as strings', () => {
    assert.equal(exec('if 5 is 5 then\nreturn "eq"\nend\nreturn "ne"'), 'eq');
    assert.equal(exec('if "5" is 5 then\nreturn "eq"\nend\nreturn "ne"'), 'eq', 'numeric string vs number — numeric comparison');
    assert.equal(exec('if "a" is "a" then\nreturn "eq"\nend\nreturn "ne"'), 'eq');
    assert.equal(exec('if "a" is not "b" then\nreturn "ne"\nend\nreturn "eq"'), 'ne');
});

test('and / or short-circuit and not negates', () => {
    assert.equal(exec('if true and false then\nreturn "a"\nend\nreturn "b"'), 'b');
    assert.equal(exec('if true or false then\nreturn "a"\nend\nreturn "b"'), 'a');
    assert.equal(exec('if not false then\nreturn "a"\nend\nreturn "b"'), 'a');
});

// --- Control flow ---

test('if/else', () => {
    assert.equal(exec('if 1 > 2 then\nreturn "a"\nelse\nreturn "b"\nend'), 'b');
    assert.equal(exec('if 2 > 1 then\nreturn "a"\nelse\nreturn "b"\nend'), 'a');
});

test('if with no else and a false condition falls through with no value', () => {
    assert.equal(exec('if false then\nset x to 1\nend\nreturn "after"'), 'after');
});

test('repeat N times runs the body exactly N times', () => {
    assert.equal(exec('set total to 0\nrepeat 5 times\nset total to total + 1\nend\nreturn total'), '5');
});

test('repeat with a non-positive count runs zero times, not an error', () => {
    assert.equal(exec('set total to 0\nrepeat 0 times\nset total to total + 1\nend\nreturn total'), '0');
    assert.equal(exec('set total to 0\nrepeat -3 times\nset total to total + 1\nend\nreturn total'), '0');
});

test('while runs until the condition is false', () => {
    assert.equal(exec('set x to 0\nwhile x < 5\nset x to x + 1\nend\nreturn x'), '5');
});

test('a return inside a loop exits the loop and the whole program immediately', () => {
    assert.equal(exec('set x to 0\nrepeat 10 times\nset x to x + 1\nif x is 3 then\nreturn "stopped"\nend\nend\nreturn "never"'), 'stopped');
});

test('nested if/repeat/while all share one flat variable scope', () => {
    const source = 'set total to 0\nrepeat 3 times\nset i to 0\nwhile i < 2\nset total to total + 1\nset i to i + 1\nend\nend\nreturn total';
    assert.equal(exec(source), '6');
});

// --- get/save ---

test('get reads whatever the injected get() returns, save calls the injected save()', () => {
    const bus = { 'tracker:field:vitals:health': '30', 'tracker:field:vitals:shield': '20' };
    const get = key => bus[key];
    const saved = [];
    const save = (key, value) => saved.push([key, value]);
    const value = exec('set h to get "tracker:field:vitals:health"\nset s to get "tracker:field:vitals:shield"\nsave h + s as "total"\nreturn h + s', { get, save });
    assert.equal(value, '50');
    assert.deepEqual(saved, [['total', 50]]);
});

test('get for a missing key returns whatever the injected get() gives back (undefined by default) without throwing', () => {
    assert.equal(exec('set x to get "nothing:here"\nreturn "ok"'), 'ok');
});

// --- Comments ---

test('# starts a comment to the end of the line', () => {
    assert.equal(exec('# this is ignored\nset x to 5 # also ignored\nreturn x'), '5');
});

// --- Tokenizer/parser errors (MacroSyntaxError) ---

test('tokenize throws MacroSyntaxError for an unterminated string', () => {
    assert.throws(() => tokenize('return "unterminated'), MacroSyntaxError);
});

test('tokenize throws MacroSyntaxError for an unexpected character', () => {
    assert.throws(() => tokenize('return 1 @ 2'), MacroSyntaxError);
});

test('parse throws MacroSyntaxError for an incomplete expression', () => {
    assert.throws(() => exec('set x to 1 +'), MacroSyntaxError);
});

test('parse throws MacroSyntaxError for a missing "end"', () => {
    assert.throws(() => exec('if true then\nreturn 1'), MacroSyntaxError);
});

test('parse throws MacroSyntaxError for an unknown statement keyword', () => {
    assert.throws(() => exec('foo bar'), MacroSyntaxError);
});

// --- Time limit ---
//
// Two independent safety nets exist: the wall-clock check (the real, documented
// guardrail) and a loop-iteration cap (a backstop for the pathological case where
// Date.now() doesn't advance between checks). For a trivial, empty-body loop on fast
// hardware the iteration cap can legitimately win the race — millisecond clock
// resolution means many iterations fit inside one tick. Which ONE of the two fires
// is an implementation detail; the guarantee that matters is that execution is
// always bounded and always reported as a failure, so these tests check that, not
// a specific error subclass. A program with real per-iteration work (see below)
// exercises the wall-clock path specifically and reliably.

test('an infinite loop always aborts safely — via the time limit or, on fast hardware, the iteration backstop', () => {
    const result = execute('while true\nend', { timeLimitMs: 10 });
    assert.equal(result.ok, false);
    assert.match(result.error.message, /time limit|exceeded \d+ iterations/);
});

test('run() throws (does not silently hang) for an infinite loop', () => {
    assert.throws(() => run(parse(tokenize('while true\nend')), { timeLimitMs: 10 }));
});

test('a heavier-bodied infinite loop reliably hits the wall-clock limit specifically', () => {
    // Real per-iteration work (an addition + assignment) makes 100,000 iterations
    // take measurably longer than an empty body — comfortably past a 10ms budget
    // before the iteration cap could plausibly be reached.
    const result = execute('set total to 0\nwhile true\nset total to total + 1\nend', { timeLimitMs: 10 });
    assert.equal(result.ok, false);
    assert.ok(result.error instanceof MacroTimeoutError, `expected the wall-clock limit to fire first for a non-trivial loop body, got: ${result.error}`);
});

test('the default time limit is a small, fixed number of milliseconds', async () => {
    const { DEFAULT_TIME_LIMIT_MS } = await import('../modules/macros/language.js');
    assert.ok(DEFAULT_TIME_LIMIT_MS > 0 && DEFAULT_TIME_LIMIT_MS <= 200);
});

// --- execute() never throws, for any kind of failure ---

test('execute() normalizes every failure kind (syntax, runtime, timeout) into { ok: false, error } — never throws itself', () => {
    for (const source of ['set x to 1 +', 'return 1 / 0', 'while true\nend']) {
        const result = execute(source, { timeLimitMs: 10 });
        assert.equal(result.ok, false);
        assert.ok(result.error instanceof Error);
    }
});

test('execute() on a valid program returns { ok: true, value }', () => {
    assert.deepEqual(execute('return 1 + 1'), { ok: true, value: '2' });
});

test('a program with no return resolves to an empty string, not an error', () => {
    assert.equal(exec('set x to 5'), '');
});

test('true/false render as the words "true"/"false"', () => {
    assert.equal(exec('return true'), 'true');
    assert.equal(exec('return false'), 'false');
});
