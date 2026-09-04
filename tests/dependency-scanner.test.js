import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DependencyScanner } from '../core/dependency-scanner.js';
import { ModuleDataBus } from '../core/data-bus.js';

function makeScanner(moduleIds) {
    const bus = new ModuleDataBus({ getContext: () => ({}) });
    const scanner = new DependencyScanner(bus, () => moduleIds);
    return { bus, scanner };
}

test('edges() is empty when no module has published anything', () => {
    const { scanner } = makeScanner(['a', 'b']);
    assert.deepEqual(scanner.edges(), []);
});

test('edges() reads a published { owner, kind, detail } array from a module\'s own "dependencies" key', () => {
    const { bus, scanner } = makeScanner(['macros', 'tracker']);
    bus.set('macros', 'dependencies', [{ owner: 'tracker', kind: 'macro-get', detail: 'tracker:field:x' }]);
    assert.deepEqual(scanner.edges(), [{ consumer: 'macros', owner: 'tracker', kind: 'macro-get', detail: 'tracker:field:x' }]);
});

test('edges() aggregates across every module, not just the first one that published', () => {
    const { bus, scanner } = makeScanner(['a', 'b', 'c']);
    bus.set('a', 'dependencies', [{ owner: 'c', kind: 'x' }]);
    bus.set('b', 'dependencies', [{ owner: 'c', kind: 'y' }]);
    const owners = scanner.edges().map(edge => `${edge.consumer}->${edge.owner}`).sort();
    assert.deepEqual(owners, ['a->c', 'b->c']);
});

test('a self-edge (a module "depending on" its own namespace) is silently dropped, not a real dependency', () => {
    const { bus, scanner } = makeScanner(['a']);
    bus.set('a', 'dependencies', [{ owner: 'a', kind: 'x' }]);
    assert.deepEqual(scanner.edges(), []);
});

test('an edge with no owner, or a non-array published value, is ignored rather than throwing', () => {
    const { bus, scanner } = makeScanner(['a', 'b']);
    bus.set('a', 'dependencies', [{ kind: 'x' }, null, { owner: '' }]);
    bus.set('b', 'dependencies', 'not an array');
    assert.doesNotThrow(() => scanner.edges());
    assert.deepEqual(scanner.edges(), []);
});

test('a missing "kind" defaults to \'unknown\' rather than being dropped', () => {
    const { bus, scanner } = makeScanner(['a']);
    bus.set('a', 'dependencies', [{ owner: 'b' }]);
    assert.deepEqual(scanner.edges(), [{ consumer: 'a', owner: 'b', kind: 'unknown', detail: null }]);
});

test('dependenciesOf() returns the distinct set of owners one module depends on, deduplicated across edges', () => {
    const { bus, scanner } = makeScanner(['a']);
    bus.set('a', 'dependencies', [{ owner: 'b', kind: 'x' }, { owner: 'b', kind: 'y' }, { owner: 'c', kind: 'x' }]);
    assert.deepEqual(scanner.dependenciesOf('a').sort(), ['b', 'c']);
});

test('dependentsOf() is the reverse direction — who depends on this module', () => {
    const { bus, scanner } = makeScanner(['a', 'b']);
    bus.set('a', 'dependencies', [{ owner: 'shared', kind: 'x' }]);
    bus.set('b', 'dependencies', [{ owner: 'shared', kind: 'y' }]);
    assert.deepEqual(scanner.dependentsOf('shared').sort(), ['a', 'b']);
});

test('edges() reflects a re-publish immediately — no caching to go stale', () => {
    const { bus, scanner } = makeScanner(['a']);
    bus.set('a', 'dependencies', [{ owner: 'b', kind: 'x' }]);
    assert.equal(scanner.dependenciesOf('a').length, 1);
    bus.set('a', 'dependencies', []);
    assert.equal(scanner.dependenciesOf('a').length, 0);
});

// --- Webhook edges — needs no module cooperation/publishing at all, derived
// straight from reserve()'s own webhook config via listChannels()/describe().

// A `pullUrl` makes reserve() start a REAL setInterval that will eventually call
// fetch() against whatever URL was given — see data-bus.js's #startPulling.
// Every test below that reserves one must unreserve() it before the test ends,
// so that interval is cleared long before its first real tick (MIN_PULL_INTERVAL_MS
// is 5000ms — nothing here runs anywhere near that long) instead of leaking a timer
// that would otherwise fire a genuine outbound request against a fake test domain.

test('a pull webhook becomes a webhook-pull edge, owned by a generic external:<hostname> pseudo-node — never a real module id', () => {
    const { bus, scanner } = makeScanner(['a']);
    bus.reserve('a', 'x', { webhook: { pullUrl: 'https://api.example.com/data?token=secret123' } });
    try {
        assert.deepEqual(scanner.edges(), [{ consumer: 'a', owner: 'external:api.example.com', kind: 'webhook-pull', detail: 'api.example.com' }]);
    } finally { bus.unreserve('a', 'x'); }
});

test('a push webhook becomes a webhook-push edge, tagged distinctly from pull — opposite direction (outbound effect, not a dependency)', () => {
    const { bus, scanner } = makeScanner(['a']);
    bus.reserve('a', 'x', { allowExternalWrite: true, webhook: { pushUrl: 'https://hooks.example.com/notify' } });
    assert.deepEqual(scanner.edges(), [{ consumer: 'a', owner: 'external:hooks.example.com', kind: 'webhook-push', detail: 'hooks.example.com' }]);
});

test('a channel with both push and pull produces two separate edges', () => {
    const { bus, scanner } = makeScanner(['a']);
    bus.reserve('a', 'x', { allowExternalWrite: true, webhook: { pullUrl: 'https://in.example.com/', pushUrl: 'https://out.example.com/' } });
    try {
        const kinds = scanner.edges().map(edge => `${edge.kind}:${edge.owner}`).sort();
        assert.deepEqual(kinds, ['webhook-pull:external:in.example.com', 'webhook-push:external:out.example.com']);
    } finally { bus.unreserve('a', 'x'); }
});

test('only the hostname is kept, never the full URL — a webhook URL can carry a token/key in its query string', () => {
    const { bus, scanner } = makeScanner(['a']);
    bus.reserve('a', 'x', { webhook: { pullUrl: 'https://api.example.com/v1/secret-path?apiKey=do-not-leak-me' } });
    try {
        const [edge] = scanner.edges();
        assert.equal(edge.detail, 'api.example.com');
        assert.ok(!JSON.stringify(edge).includes('do-not-leak-me'), 'the token must never appear anywhere in the edge');
    } finally { bus.unreserve('a', 'x'); }
});

test('a channel with no webhook config contributes no webhook edges', () => {
    const { bus, scanner } = makeScanner(['a']);
    bus.reserve('a', 'x', { schema: { type: 'string' } });
    assert.deepEqual(scanner.edges(), []);
});

test('an unparseable webhook URL degrades to owner "external:unknown" instead of throwing', () => {
    const { bus, scanner } = makeScanner(['a']);
    bus.reserve('a', 'x', { webhook: { pullUrl: 'not a url at all' } });
    try {
        assert.doesNotThrow(() => scanner.edges());
        assert.deepEqual(scanner.edges(), [{ consumer: 'a', owner: 'external:unknown', kind: 'webhook-pull', detail: 'unknown' }]);
    } finally { bus.unreserve('a', 'x'); }
});

test('webhook edges combine with self-published edges in the same edges() list', () => {
    const { bus, scanner } = makeScanner(['macros', 'tracker']);
    bus.set('macros', 'dependencies', [{ owner: 'tracker', kind: 'macro-get', detail: 'tracker:x' }]);
    bus.reserve('tracker', 'y', { webhook: { pullUrl: 'https://api.example.com/' } });
    try {
        const kinds = scanner.edges().map(edge => edge.kind).sort();
        assert.deepEqual(kinds, ['macro-get', 'webhook-pull']);
    } finally { bus.unreserve('tracker', 'y'); }
});

// --- scanServiceContracts() — regex-parses each module's own RAW SOURCE for
// host.services.register/request/get/ask('name') literal calls. Async, cached
// in #serviceEdges (unlike the two sources above) until re-scanned.

function makeSourceMap(sources) {
    return async id => (id in sources ? `https://example.test/${id}.js` : null);
}

function makeFetchImpl(sources) {
    return async url => {
        const id = decodeURIComponent(String(url)).replace('https://example.test/', '').replace('.js', '');
        if (!(id in sources)) return { ok: false, status: 404 };
        return { ok: true, text: async () => sources[id] };
    };
}

test('scanServiceContracts finds a consumer->provider edge when the provider registers a matching service name', async () => {
    const { scanner } = makeScanner(['music', 'tracker']);
    const sources = {
        tracker: `activate(host) { host.services.register('tracker', { classify: () => {} }); }`,
        music: `activate(host) { host.services.ask('tracker', 'classify', {}); }`,
    };
    const edges = await scanner.scanServiceContracts(makeSourceMap(sources), { fetchImpl: makeFetchImpl(sources) });
    assert.deepEqual(edges, [{ consumer: 'music', owner: 'tracker', kind: 'service', detail: 'tracker' }]);
    assert.deepEqual(scanner.edges(), edges, 'the scan result is cached into edges() too');
});

test('scanServiceContracts recognizes request(), get(), and ask() as consumption, deduplicated into one edge per module/service pair', async () => {
    const { scanner } = makeScanner(['a', 'b']);
    const sources = {
        b: `host.services.register('svc', {});`,
        a: `host.services.request('svc'); host.services.get('svc'); host.services.ask('svc', 'x', {});`,
    };
    const edges = await scanner.scanServiceContracts(makeSourceMap(sources), { fetchImpl: makeFetchImpl(sources) });
    assert.deepEqual(edges, [{ consumer: 'a', owner: 'b', kind: 'service', detail: 'svc' }]);
});

test('a service with no known provider still becomes an edge, owned by a service:<name> pseudo-node — visible, not dropped', async () => {
    const { scanner } = makeScanner(['a']);
    const sources = { a: `host.services.request('nobody-provides-this');` };
    const edges = await scanner.scanServiceContracts(makeSourceMap(sources), { fetchImpl: makeFetchImpl(sources) });
    assert.deepEqual(edges, [{ consumer: 'a', owner: 'service:nobody-provides-this', kind: 'service', detail: 'nobody-provides-this' }]);
});

test('a module "consuming" its own registered service is not a dependency — no self-edge', async () => {
    const { scanner } = makeScanner(['a']);
    const sources = { a: `host.services.register('svc', {}); host.services.request('svc');` };
    const edges = await scanner.scanServiceContracts(makeSourceMap(sources), { fetchImpl: makeFetchImpl(sources) });
    assert.deepEqual(edges, []);
});

test('a service call split across lines (host.services\\n.ask(...), real formatting used in this codebase) is still recognized', async () => {
    const { scanner } = makeScanner(['music', 'tracker']);
    const sources = {
        tracker: `host.services.register('tracker', { classify: () => {} });`,
        music: `pendingClassify = host.services\n                .ask('tracker', 'classify', { vocabulary })\n                .catch(() => null);`,
    };
    const edges = await scanner.scanServiceContracts(makeSourceMap(sources), { fetchImpl: makeFetchImpl(sources) });
    assert.deepEqual(edges, [{ consumer: 'music', owner: 'tracker', kind: 'service', detail: 'tracker' }]);
});

test('a non-literal service name argument is invisible to the regex — a real, accepted limitation, not a crash', async () => {
    const { scanner } = makeScanner(['a']);
    const sources = { a: `const name = 'svc'; host.services.request(name);` };
    const edges = await scanner.scanServiceContracts(makeSourceMap(sources), { fetchImpl: makeFetchImpl(sources) });
    assert.deepEqual(edges, []);
});

test('scanServiceContracts never throws — a module with no URL, a fetch failure, or a 404 just contributes no edges', async () => {
    const { scanner } = makeScanner(['a', 'b', 'c']);
    const getSourceUrl = async id => (id === 'a' ? null : `https://example.test/${id}.js`);
    const fetchImpl = async url => {
        if (String(url).includes('/b.js')) throw new Error('network down');
        return { ok: false, status: 404 };
    };
    await assert.doesNotReject(() => scanner.scanServiceContracts(getSourceUrl, { fetchImpl }));
    assert.deepEqual(scanner.edges(), []);
});

test('scanServiceContracts caches its result — edges() is synchronous and keeps returning the last scan without re-fetching anything', async () => {
    const { scanner } = makeScanner(['a', 'b']);
    const sources = { b: `host.services.register('svc', {});`, a: `host.services.request('svc');` };
    await scanner.scanServiceContracts(makeSourceMap(sources), { fetchImpl: makeFetchImpl(sources) });
    assert.equal(scanner.edges().length, 1);
    assert.deepEqual(scanner.edges(), scanner.edges(), 'calling edges() again (synchronously, no await) returns the same cached result');
});

// --- Real smoke test against this repo's ACTUAL built-in module files (not
// synthetic sources) — proves the regex still finds the real, already-existing
// relationships in this codebase, so a future edit to either the regex or a
// built-in module's own host.services usage that breaks this gets caught here
// instead of silently going stale.

// --- activationInfo() — synchronous, real in-memory metadata, deliberately
// NOT part of edges() (see the class doc comment for why).

test('activationInfo returns defaultEnabled/minEngineVersion from the injected getModuleMeta accessor', () => {
    const bus = new ModuleDataBus({ getContext: () => ({}) });
    const meta = { a: { defaultEnabled: false, minEngineVersion: '0.2.0' } };
    const scanner = new DependencyScanner(bus, () => ['a'], id => meta[id]);
    assert.deepEqual(scanner.activationInfo('a'), { defaultEnabled: false, minEngineVersion: '0.2.0' });
});

test('activationInfo degrades to null fields for an unknown id or when no getModuleMeta was given — never throws', () => {
    const bus = new ModuleDataBus({ getContext: () => ({}) });
    const withAccessor = new DependencyScanner(bus, () => [], () => null);
    assert.deepEqual(withAccessor.activationInfo('missing'), { defaultEnabled: null, minEngineVersion: null });

    const withoutAccessor = new DependencyScanner(bus, () => []);
    assert.deepEqual(withoutAccessor.activationInfo('anything'), { defaultEnabled: null, minEngineVersion: null });
});

test('activationInfo results never appear in edges() — metadata, not a dependency relationship', () => {
    const bus = new ModuleDataBus({ getContext: () => ({}) });
    const scanner = new DependencyScanner(bus, () => ['a'], () => ({ defaultEnabled: true, minEngineVersion: '1.0.0' }));
    assert.deepEqual(scanner.edges(), []);
});

// --- scanActivationConditions() — event subscriptions + cross-namespace
// host.data reads, its own fetch pass (see the method's doc comment for why
// it's separate from scanServiceContracts() rather than sharing one fetch).

test('scanActivationConditions finds an onEvent subscription, owned by a st-event:<NAME> pseudo-node', async () => {
    const { scanner } = makeScanner(['a']);
    const sources = { a: `host.onEvent('GENERATION_STARTED', () => {});` };
    const edges = await scanner.scanActivationConditions(makeSourceMap(sources), { fetchImpl: makeFetchImpl(sources) });
    assert.deepEqual(edges, [{ consumer: 'a', owner: 'st-event:GENERATION_STARTED', kind: 'event-subscription', detail: 'GENERATION_STARTED' }]);
});

test('scanActivationConditions finds onChatChanged as its own event-subscription edge, by presence only', async () => {
    const { scanner } = makeScanner(['a']);
    const sources = { a: `const unsub = host.onChatChanged(() => sync());` };
    const edges = await scanner.scanActivationConditions(makeSourceMap(sources), { fetchImpl: makeFetchImpl(sources) });
    assert.deepEqual(edges, [{ consumer: 'a', owner: 'st-event:CHAT_CHANGED', kind: 'event-subscription', detail: 'CHAT_CHANGED' }]);
});

test('scanActivationConditions finds a cross-namespace host.data.read/subscribe, owned by the real namespace (no pseudo-node)', async () => {
    const { scanner } = makeScanner(['a', 'tracker']);
    const sources = { a: `host.data.subscribe('tracker', 'field:x', v => {});`, tracker: '' };
    const edges = await scanner.scanActivationConditions(makeSourceMap(sources), { fetchImpl: makeFetchImpl(sources) });
    assert.deepEqual(edges, [{ consumer: 'a', owner: 'tracker', kind: 'data-read', detail: 'tracker' }]);
});

test('scanActivationConditions does not treat a module reading its OWN namespace as a dependency', async () => {
    const { scanner } = makeScanner(['tracker']);
    const sources = { tracker: `host.data.subscribe('tracker', 'field:x', v => {});` };
    const edges = await scanner.scanActivationConditions(makeSourceMap(sources), { fetchImpl: makeFetchImpl(sources) });
    assert.deepEqual(edges, []);
});

test('scanActivationConditions finds a cross-namespace host.data.write, owned by the real namespace and tagged as a distinct kind from data-read', async () => {
    const { scanner } = makeScanner(['a', 'tracker']);
    const sources = { a: `host.data.write('tracker', 'quick:x', 42);`, tracker: '' };
    const edges = await scanner.scanActivationConditions(makeSourceMap(sources), { fetchImpl: makeFetchImpl(sources) });
    assert.deepEqual(edges, [{ consumer: 'a', owner: 'tracker', kind: 'data-write', detail: 'tracker' }]);
});

test('scanActivationConditions does not treat a module writing its OWN namespace as a dependency', async () => {
    const { scanner } = makeScanner(['tracker']);
    const sources = { tracker: `host.data.write('tracker', 'quick:x', 42);` };
    const edges = await scanner.scanActivationConditions(makeSourceMap(sources), { fetchImpl: makeFetchImpl(sources) });
    assert.deepEqual(edges, []);
});

test('scanActivationConditions deduplicates repeated subscriptions to the same event in one module', async () => {
    const { scanner } = makeScanner(['a']);
    const sources = { a: `host.onEvent('MESSAGE_RECEIVED', f); host.onEvent('MESSAGE_RECEIVED', g);` };
    const edges = await scanner.scanActivationConditions(makeSourceMap(sources), { fetchImpl: makeFetchImpl(sources) });
    assert.equal(edges.length, 1);
});

test('scanActivationConditions never throws and its result is cached in edges() alongside scanServiceContracts\' own cache', async () => {
    const { scanner } = makeScanner(['a', 'b']);
    const sources = {
        b: `host.services.register('svc', {});`,
        a: `host.services.request('svc'); host.onEvent('GENERATION_STARTED', f);`,
    };
    await scanner.scanServiceContracts(makeSourceMap(sources), { fetchImpl: makeFetchImpl(sources) });
    await scanner.scanActivationConditions(makeSourceMap(sources), { fetchImpl: makeFetchImpl(sources) });
    const kinds = scanner.edges().map(edge => edge.kind).sort();
    assert.deepEqual(kinds, ['event-subscription', 'service']);
});

test('scanServiceContracts finds the real Music->Tracker and Notebook->Time edges in this repo\'s actual built-in modules', async () => {
    const builtIns = ['notebook', 'time', 'tracker', 'music', 'macros'];
    const { scanner } = makeScanner(builtIns);
    const getSourceUrl = async id => new URL(`../modules/${id}/index.js`, import.meta.url);
    const fetchImpl = async url => ({ ok: true, text: async () => readFile(fileURLToPath(url), 'utf8') });

    const edges = await scanner.scanServiceContracts(getSourceUrl, { fetchImpl });
    const summary = edges.map(edge => `${edge.consumer}->${edge.owner}`).sort();
    assert.ok(summary.includes('music->tracker'), `expected music->tracker among: ${summary.join(', ')}`);
    assert.ok(summary.includes('notebook->time'), `expected notebook->time among: ${summary.join(', ')}`);
});

test('scanActivationConditions finds the real event subscriptions in this repo\'s actual built-in modules', async () => {
    const builtIns = ['notebook', 'time', 'tracker', 'music', 'macros'];
    const { scanner } = makeScanner(builtIns);
    const getSourceUrl = async id => new URL(`../modules/${id}/index.js`, import.meta.url);
    const fetchImpl = async url => ({ ok: true, text: async () => readFile(fileURLToPath(url), 'utf8') });

    const edges = await scanner.scanActivationConditions(getSourceUrl, { fetchImpl });
    const summary = edges.map(edge => `${edge.consumer}:${edge.detail}`).sort();
    // 'time' deliberately has no GENERATION_STARTED entry: RP Time now triggers
    // entirely from MESSAGE_RECEIVED (post-generation, so its SideCar request can
    // see the character's actual new reply) — see MODULES.md/the memory note on
    // why the earlier GENERATION_STARTED-triggered version was changed.
    for (const expected of ['music:GENERATION_STARTED', 'music:MESSAGE_RECEIVED', 'time:MESSAGE_RECEIVED', 'tracker:GENERATION_STARTED', 'macros:CHAT_CHANGED', 'notebook:CHAT_CHANGED', 'time:CHAT_CHANGED', 'tracker:CHAT_CHANGED']) {
        assert.ok(summary.includes(expected), `expected ${expected} among: ${summary.join(', ')}`);
    }
    // Confirmed by grep before this feature was built: no built-in module did a raw
    // cross-namespace host.data.read/subscribe/write at the time (everything went
    // through host.services) — a data-read/data-write edge appearing here would mean
    // either a false positive in the regex, or a real change to a built-in module
    // that should be reflected in this test's own expectations. Macros' own tracker
    // picker (modules/macros/index.js's render(), reading Tracker's published
    // `blocks` index to list real fields to insert) is exactly that real change —
    // still no data-write anywhere, and still no OTHER raw data-read.
    const dataEdges = edges.filter(edge => edge.kind === 'data-read' || edge.kind === 'data-write');
    assert.deepEqual(dataEdges, [{ consumer: 'macros', owner: 'tracker', kind: 'data-read', detail: 'tracker' }]);
});
