function getUsageStreamOverrides(provider) {
  if (provider !== 'openai') return undefined;

  return {
    // OpenAI-compatible streaming APIs commonly omit usage unless it is
    // explicitly requested. Completed, rejected, and failed generations must
    // still be accounted for.
    params: { stream_options: { include_usage: true } },
  };
}

function getContinuationStreamOverrides(model, provider) {
  const usageOverrides = getUsageStreamOverrides(provider);
  if (!usageOverrides) return undefined;

  const modelId = String(model || '').trim().toLowerCase().split('/').pop() || '';
  if (!modelId.startsWith('kimi-k3')) return usageOverrides;

  return {
    ...usageOverrides,
    // Existing ai-request-parameters.json files are intentionally not
    // overwritten when built-in model rules gain a new Kimi alias. Keep the
    // continuation request valid after users switch such an installation to
    // Kimi K3 Preview.
    omit: ['temperature'],
  };
}

function getPolishStreamOverrides(model, provider) {
  const usageOverrides = getUsageStreamOverrides(provider);
  if (!usageOverrides) return undefined;

  const modelId = String(model || '').trim().toLowerCase().split('/').pop() || '';
  if (!modelId.startsWith('kimi-k3')) return usageOverrides;

  // Kimi K3 always reasons first. Reserve enough output for both the reasoning
  // trace and the full replacement chapter, while retaining usage reporting.
  return {
    params: {
      ...usageOverrides.params,
      reasoning_effort: 'low',
      max_completion_tokens: 32768,
    },
    // Keep this task-level guard even when a user's existing generated
    // ai-request-parameters.json predates a newly introduced Kimi model alias.
    omit: ['max_tokens', 'temperature'],
  };
}

module.exports = {
  getContinuationStreamOverrides,
  getPolishStreamOverrides,
  getUsageStreamOverrides,
};
