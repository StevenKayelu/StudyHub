/** Status badge per order status (S-L11, S-AD04). */
export const ORDER_BADGES = {
  PENDING: 'pending',
  PAID: 'paid',
  EXPIRED: 'draft',
  CANCELLED: 'draft',
  REFUNDED: 'attention',
} as const;

/** Status badge per platform statement status (W8: S-AD21 and the console). */
export const STATEMENT_BADGES = {
  DRAFT: 'draft',
  ISSUED: 'attention',
  PAID: 'paid',
  VOID: 'draft',
} as const;

/** Status badge per school lifecycle status (console, F37). */
export const TENANT_BADGES = {
  PROVISIONING: 'pending',
  ACTIVE: 'published',
  SUSPENDED: 'attention',
  OFFBOARDING: 'attention',
  DELETED: 'draft',
} as const;
