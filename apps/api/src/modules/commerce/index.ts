// Public surface of the commerce module (enforced by dependency-cruiser).
export { paymentsProblem } from './application/readiness';
export {
  checkLedger,
  createLedgerCheckHandler,
  createLedgerReleaseHandler,
  createOrderExpireHandler,
  createPaymentCheckHandler,
  createPaymentEventHandler,
  enqueueDueLedgerChecks,
  type LedgerCheckResult,
} from './application/jobs';
export {
  BALANCE_REMINDER_JOB,
  type CommerceDeps,
  createBalanceReminderHandler,
  LEDGER_CHECK_JOB,
  LEDGER_RELEASE_JOB,
  ORDER_EXPIRE_JOB,
  PAYMENT_CHECK_JOB,
  PAYMENT_EVENT_JOB,
} from './application/settlement';
export {
  FAKE_PAY_SIGNATURE_HEADER,
  FAKE_PROFILE_CAPABILITIES,
  FAKE_SANDBOX_SUFFIXES,
  FakePaymentProvider,
} from './infra/fake-payment-provider';
export { createPaymentGateway, PAYMENT_GATEWAY, PaymentGateway } from './infra/payment-gateway';
export { PaymentVault } from './infra/payment-vault';
export { CommerceModule } from './commerce.module';
export { type DepositPlanInput, depositPlanProblems, planOffered } from './domain/deposit-rules';
