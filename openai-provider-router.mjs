const OPENAI_IMAGES_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * Creates a server-only router for authorized OpenAI API projects.
 *
 * Multi-provider mode is enabled whenever OPENAI_PROVIDER_ORDER is set.
 * This intentional fail-closed switch prevents a partially configured or
 * malformed multi-provider setup from silently falling back to a legacy
 * OPENAI_API_KEY.
 */
export function createOpenAIProviderRouter({ getEnv, fetchImpl = fetch, now = () => Date.now() } = {}) {
  if (typeof getEnv !== 'function') {
    throw new TypeError('getEnv must be a function');
  }

  const rawOrder = readSetting(getEnv, 'OPENAI_PROVIDER_ORDER');
  const multiProviderMode = rawOrder.length > 0;
  const configuredIds = parseProviderIds(rawOrder);
  const providers = multiProviderMode
    ? configuredIds.map(id => createConfiguredProvider(id, getEnv)).filter(Boolean)
    : createLegacyProvider(getEnv);

  async function request(pathname, requestInit) {
    const availableProviders = providers.filter(provider => isProviderAvailable(provider, now()));
    if (availableProviders.length === 0) {
      throw unavailableProviderError(providers, now(), multiProviderMode);
    }

    const attempts = [];
    for (const provider of availableProviders) {
      provider.requestCount += 1;

      let response;
      try {
        const headers = new Headers(requestInit.headers || {});
        headers.set('Authorization', `Bearer ${provider.apiKey}`);
        response = await fetchImpl(`${OPENAI_IMAGES_BASE_URL}${pathname}`, {
          ...requestInit,
          headers,
        });
      } catch {
        // A transport failure is ambiguous: the upstream may still generate an
        // image after the connection breaks. Do not fail over and risk a second charge.
        throw providerError('provider_network_error', {
          providerId: provider.id,
          attempts,
          statusCode: 502,
        });
      }

      const providerStatus = Number(response.status) || 0;
      if (response.ok) {
        return {
          response,
          providerId: provider.id,
          providerStatus,
          attempts,
        };
      }

      const retryable = isSafeFailoverStatus(providerStatus);
      attempts.push({ providerId: provider.id, providerStatus, retryable });
      if (!retryable) {
        throw providerError('provider_error', {
          providerId: provider.id,
          providerStatus,
          attempts,
          statusCode: 502,
        });
      }

      // A 429/5xx is an explicit upstream failure, so this provider can be
      // temporarily opened while the next enabled provider is attempted.
      // Do not apply this path to rejected fetches: their result is ambiguous.
      provider.blockedUntil = now() + provider.cooldownMs;
    }

    const lastAttempt = attempts.at(-1) || {};
    throw providerError('provider_retryable_error', {
      providerId: lastAttempt.providerId || '',
      providerStatus: lastAttempt.providerStatus || 0,
      attempts,
      statusCode: 503,
    });
  }

  return {
    request,
    hasConfiguredProvider: () => providers.length > 0,
    getSummary: () => ({
      mode: multiProviderMode ? 'multi_provider' : 'legacy_single_key',
      providerIds: providers.map(provider => provider.id),
      providers: providers.map(provider => ({
        id: provider.id,
        enabled: provider.enabled,
        requestCount: provider.requestCount,
        maxRequests: provider.maxRequests,
        blockedUntil: provider.blockedUntil,
      })),
    }),
  };
}

function createLegacyProvider(getEnv) {
  const apiKey = readSetting(getEnv, 'OPENAI_API_KEY');
  if (!isUsableApiKey(apiKey)) return [];

  return [{
    id: 'legacy',
    apiKey,
    enabled: true,
    maxRequests: 0,
    requestCount: 0,
    cooldownMs: DEFAULT_COOLDOWN_MS,
    blockedUntil: 0,
  }];
}

function createConfiguredProvider(id, getEnv) {
  const suffix = id.toUpperCase();
  const apiKey = readSetting(getEnv, `OPENAI_PROVIDER_${suffix}_API_KEY`);
  if (!isUsableApiKey(apiKey)) return null;

  return {
    id,
    apiKey,
    enabled: readBoolean(getEnv, `OPENAI_PROVIDER_${suffix}_ENABLED`, true),
    maxRequests: readNonNegativeInt(getEnv, `OPENAI_PROVIDER_${suffix}_MAX_REQUESTS`, 0),
    requestCount: 0,
    cooldownMs: readPositiveInt(
      getEnv,
      `OPENAI_PROVIDER_${suffix}_COOLDOWN_MS`,
      readPositiveInt(getEnv, 'OPENAI_PROVIDER_COOLDOWN_MS', DEFAULT_COOLDOWN_MS)
    ),
    blockedUntil: 0,
  };
}

function unavailableProviderError(providers, currentTime, multiProviderMode) {
  if (providers.length === 0) {
    return providerError('missing_api_key', {
      statusCode: 500,
      providerId: '',
      attempts: [],
    });
  }

  const capped = providers.every(provider => provider.maxRequests > 0 && provider.requestCount >= provider.maxRequests);
  const coolingDown = providers.some(provider => provider.blockedUntil > currentTime);
  return providerError(capped ? 'provider_request_limit' : (coolingDown || multiProviderMode ? 'provider_unavailable' : 'missing_api_key'), {
    statusCode: 503,
    providerId: '',
    attempts: [],
  });
}

function providerError(code, { providerId = '', providerStatus = 0, attempts = [], statusCode = 502 } = {}) {
  const error = new Error(code);
  error.code = code;
  error.providerId = providerId;
  error.providerStatus = providerStatus;
  error.providerAttempts = attempts;
  error.statusCode = statusCode;
  return error;
}

function isProviderAvailable(provider, currentTime) {
  if (!provider.enabled) return false;
  if (provider.maxRequests > 0 && provider.requestCount >= provider.maxRequests) return false;
  return provider.blockedUntil <= currentTime;
}

function isSafeFailoverStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function parseProviderIds(value) {
  const seen = new Set();
  return String(value || '')
    .split(',')
    .map(id => id.trim().toLowerCase())
    .filter(id => /^[a-z][a-z0-9_]{0,31}$/.test(id))
    .filter(id => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
}

function isUsableApiKey(value) {
  return Boolean(value && !value.includes('sk-your-api-key-here'));
}

function readSetting(getEnv, name) {
  return String(getEnv(name) || '').trim();
}

function readBoolean(getEnv, name, fallback) {
  const value = readSetting(getEnv, name).toLowerCase();
  if (!value) return fallback;
  return !['0', 'false', 'off', 'no'].includes(value);
}

function readPositiveInt(getEnv, name, fallback) {
  const parsed = Number.parseInt(readSetting(getEnv, name), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeInt(getEnv, name, fallback) {
  const parsed = Number.parseInt(readSetting(getEnv, name), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
