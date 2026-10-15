import {
  type CommerceSettings,
  type MobileNetwork,
  type PaymentCapabilities,
  type PaymentMethod,
  supportedMethods,
} from '@studyhub/contracts';

/**
 * BR-62: a school can enable only what its connected account reports as supported. These rules are used
 * by the settings form (what to offer), the settings API (what to refuse) and checkout (what to offer).
 */

export interface CapabilityProblem {
  field: 'enabledPaymentMethods' | 'refundMode';
  code: 'NOT_SUPPORTED';
  message: string;
}

/** Problems with commerce settings against the active account's capabilities (null: no active account). */
export function settingsProblems(
  settings: Pick<CommerceSettings, 'enabledPaymentMethods' | 'refundMode'>,
  capabilities: PaymentCapabilities | null,
): CapabilityProblem[] {
  const problems: CapabilityProblem[] = [];
  const supported = supportedMethods(capabilities);
  const unsupported = settings.enabledPaymentMethods.filter((method) => !supported.includes(method));
  if (capabilities !== null && unsupported.length > 0) {
    problems.push({
      field: 'enabledPaymentMethods',
      code: 'NOT_SUPPORTED',
      message: `Not supported by your payment provider: ${unsupported.join(', ')}.`,
    });
  }
  if (
    settings.refundMode === 'PROVIDER_API' &&
    (capabilities === null || capabilities.refundApi === 'NONE')
  ) {
    problems.push({
      field: 'refundMode',
      code: 'NOT_SUPPORTED',
      message: 'Your payment provider has no refund API: refunds are recorded manually.',
    });
  }
  return problems;
}

/** What checkout offers: enabled in the school's settings AND supported by the account. */
export function offeredMethods(
  enabled: readonly PaymentMethod[],
  capabilities: PaymentCapabilities | null,
): { methods: PaymentMethod[]; networks: MobileNetwork[] } {
  const supported = supportedMethods(capabilities);
  const methods = (['MOBILE_MONEY', 'CARD'] as const).filter(
    (method) => enabled.includes(method) && supported.includes(method),
  );
  const networks = methods.includes('MOBILE_MONEY') ? [...(capabilities?.mobileMoney?.networks ?? [])] : [];
  return { methods, networks };
}

/**
 * How a refund is made: through the provider when the school chose it and the account can (full
 * refunds), else recorded manually (04 §17.10 fallback; 07 M8 AC 6).
 */
export function refundModeFor(
  refundMode: CommerceSettings['refundMode'],
  capabilities: PaymentCapabilities | null,
): 'PROVIDER' | 'MANUAL' {
  return refundMode === 'PROVIDER_API' && capabilities !== null && capabilities.refundApi !== 'NONE'
    ? 'PROVIDER'
    : 'MANUAL';
}
