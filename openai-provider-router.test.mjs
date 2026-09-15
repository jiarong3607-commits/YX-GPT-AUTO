import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenAIProviderRouter } from './openai-provider-router.mjs';

function getEnvFrom(values) {
  return name => values[name] || '';
}

function response(status, body = { data: [{ b64_json: 'test-image' }] }) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('uses the legacy single key when multi-provider mode is not enabled', async () => {
  const calls = [];
  const router = createOpenAIProviderRouter({
    getEnv: getEnvFrom({ OPENAI_API_KEY: 'test-legacy-key' }),
    fetchImpl: async (url, init) => {
      calls.push({ url, authorization: new Headers(init.headers).get('authorization') });
      return response(200);
    },
  });

  const result = await router.request('/images/generations', { method: 'POST' });

  assert.equal(result.providerId, 'legacy');
  assert.equal(result.providerStatus, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/images/generations');
  assert.equal(calls[0].authorization, 'Bearer test-legacy-key');
  assert.deepEqual(router.getSummary().providerIds, ['legacy']);
  assert.doesNotMatch(JSON.stringify(router.getSummary()), /test-legacy-key/);
});

test('fails closed instead of falling back to the legacy key when multi-provider mode is incomplete', async () => {
  let calls = 0;
  const router = createOpenAIProviderRouter({
    getEnv: getEnvFrom({
      OPENAI_API_KEY: 'test-legacy-key',
      OPENAI_PROVIDER_ORDER: 'primary',
    }),
    fetchImpl: async () => {
      calls += 1;
      return response(200);
    },
  });

  await assert.rejects(
    router.request('/images/generations', { method: 'POST' }),
    error => error.code === 'missing_api_key' && error.statusCode === 500
  );
  assert.equal(calls, 0);
});

test('fails over only after explicit 429 or 5xx upstream responses', async () => {
  for (const status of [429, 503]) {
    const calls = [];
    let currentTime = 1_000;
    const router = createOpenAIProviderRouter({
      getEnv: getEnvFrom({
        OPENAI_PROVIDER_ORDER: 'primary,backup',
        OPENAI_PROVIDER_PRIMARY_API_KEY: 'test-primary-key',
        OPENAI_PROVIDER_BACKUP_API_KEY: 'test-backup-key',
        OPENAI_PROVIDER_PRIMARY_COOLDOWN_MS: '1000',
      }),
      now: () => currentTime,
      fetchImpl: async (_url, init) => {
        calls.push(new Headers(init.headers).get('authorization'));
        return calls.length === 1 ? response(status) : response(200);
      },
    });

    const result = await router.request('/images/generations', { method: 'POST' });

    assert.equal(result.providerId, 'backup');
    assert.deepEqual(result.attempts, [{ providerId: 'primary', providerStatus: status, retryable: true }]);
    assert.deepEqual(calls, ['Bearer test-primary-key', 'Bearer test-backup-key']);
    assert.ok(router.getSummary().providers.find(provider => provider.id === 'primary').blockedUntil > currentTime);
    currentTime += 1_000;
  }
});

test('does not fail over on network failures or non-retryable upstream responses', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('connection interrupted'); },
    async () => response(400),
  ]) {
    let calls = 0;
    const router = createOpenAIProviderRouter({
      getEnv: getEnvFrom({
        OPENAI_PROVIDER_ORDER: 'primary,backup',
        OPENAI_PROVIDER_PRIMARY_API_KEY: 'test-primary-key',
        OPENAI_PROVIDER_BACKUP_API_KEY: 'test-backup-key',
      }),
      fetchImpl: async (...args) => {
        calls += 1;
        return fetchImpl(...args);
      },
    });

    await assert.rejects(
      router.request('/images/generations', { method: 'POST' }),
      error => ['provider_network_error', 'provider_error'].includes(error.code)
    );
    assert.equal(calls, 1);
  }
});

test('selects the next enabled provider in configured priority order', async () => {
  const calls = [];
  const router = createOpenAIProviderRouter({
    getEnv: getEnvFrom({
      OPENAI_PROVIDER_ORDER: 'primary,backup',
      OPENAI_PROVIDER_PRIMARY_API_KEY: 'test-primary-key',
      OPENAI_PROVIDER_PRIMARY_ENABLED: 'false',
      OPENAI_PROVIDER_BACKUP_API_KEY: 'test-backup-key',
    }),
    fetchImpl: async (_url, init) => {
      calls.push(new Headers(init.headers).get('authorization'));
      return response(200);
    },
  });

  const result = await router.request('/images/generations', { method: 'POST' });

  assert.equal(result.providerId, 'backup');
  assert.deepEqual(calls, ['Bearer test-backup-key']);
});

test('skips a provider once its process-local request limit is reached', async () => {
  const calls = [];
  const router = createOpenAIProviderRouter({
    getEnv: getEnvFrom({
      OPENAI_PROVIDER_ORDER: 'primary,backup',
      OPENAI_PROVIDER_PRIMARY_API_KEY: 'test-primary-key',
      OPENAI_PROVIDER_PRIMARY_MAX_REQUESTS: '1',
      OPENAI_PROVIDER_BACKUP_API_KEY: 'test-backup-key',
      OPENAI_PROVIDER_BACKUP_MAX_REQUESTS: '1',
    }),
    fetchImpl: async (_url, init) => {
      calls.push(new Headers(init.headers).get('authorization'));
      return response(200);
    },
  });

  assert.equal((await router.request('/images/generations', { method: 'POST' })).providerId, 'primary');
  assert.equal((await router.request('/images/generations', { method: 'POST' })).providerId, 'backup');
  await assert.rejects(
    router.request('/images/generations', { method: 'POST' }),
    error => error.code === 'provider_request_limit' && error.statusCode === 503
  );
  assert.deepEqual(calls, ['Bearer test-primary-key', 'Bearer test-backup-key']);
});
