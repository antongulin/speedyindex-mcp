// Controlled constructor wiring for storage tests only. No production collector.
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  loadSubmissionConfiguration,
  submissionCredentialFingerprint,
  type SubmissionPolicy,
} from '../../src/submission-policy';
import type {
  TrustedRetryEvidence,
  TrustedRetryVerifier,
} from '../../src/submission-ledger';

export const retryFixtureUtc = Date.parse('2026-10-21T12:00:00Z');
export const retryFixtureKey = 'synthetic-retry-admission-key';
export const retryFixtureBinding =
  submissionCredentialFingerprint(retryFixtureKey);
export function fixtureRetryConfiguration(
  policyPath: string,
  stateDirectory: string,
  overrides: Partial<SubmissionPolicy> = {},
) {
  const policy: SubmissionPolicy = {
    version: 1,
    enabled: true,
    mode: 'operator_policy',
    policyRevision: 'fixture-retry',
    budgetScope: 'fixture-retry',
    credentialFingerprint: retryFixtureBinding,
    period: { kind: 'utc_day' },
    caps: { tokens: 10000, indexer: 100, checker: 100 },
    retry: {
      enabled: true,
      allowUnattributedParents: true,
      maxAttemptsPerSource: 3,
    },
    ...overrides,
  };
  writeFileSync(policyPath, JSON.stringify(policy), { mode: 0o600 });
  const configuration = loadSubmissionConfiguration({
    policyPath,
    stateDirectory,
    apiKey: retryFixtureKey,
  });
  if (configuration.state !== 'configured')
    throw new Error('Invalid synthetic retry configuration.');
  return configuration;
}
export function fixtureRetryEvidence(
  urls: readonly string[] = [
    'https://example.test/Indexed',
    'https://example.test/Unindexed?q=É#F',
    'https://example.test/next',
  ],
) {
  const report = () => ({
    size: urls.length,
    processedCount: urls.length,
    indexedUrls: urls.slice(0, 1),
    unindexedUrls: urls.slice(1),
  });
  return {
    reports: [report(), report()] as [
      ReturnType<typeof report>,
      ReturnType<typeof report>,
    ],
    eligibleUrls: urls.slice(1),
    safetyEvidenceDigests: [
      createHash('sha256').update('synthetic-complete-fences').digest('hex'),
    ],
    partitionDigest: createHash('sha256')
      .update('synthetic-partition')
      .digest('hex'),
  };
}
export function fixtureRetryVerifier(
  evidence: TrustedRetryEvidence,
): TrustedRetryVerifier {
  return {
    async collectAndVerify() {
      return evidence;
    },
  };
}
