import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect } from 'react';

import { Button } from './button.js';
import { Card, Money, ProgressLine, StatCard, Stepper } from './data-display.js';
import { Dialog, Sheet } from './dialog.js';
import { Alert, Banner, SaveIndicator, Skeleton, StatusBadge } from './feedback.js';
import { SecondaryNav, Tabs } from './tabs.js';
import { ToastProvider, useToast } from './toast.js';

const meta: Meta = { title: 'Feedback and display' };
export default meta;

export const Alerts: StoryObj = {
  render: () => (
    <div className="flex max-w-xl flex-col gap-3">
      <Alert tone="info" title="Payments are in test mode">
        No money moves until your payment account is active.
      </Alert>
      <Alert tone="success" title="Payment received">
        Your receipt is on its way.
      </Alert>
      <Alert tone="warning" title="Your order expires in 10 minutes" />
      <Alert tone="danger" title="We couldn't reach MTN" action={<Button size="sm">Try again</Button>}>
        Your phone wasn't charged.
      </Alert>
    </div>
  ),
};

export const Banners: StoryObj = {
  parameters: { layout: 'fullscreen' },
  render: () => (
    <div className="flex flex-col">
      <Banner tone="warning">You're offline. We'll sync when you're back.</Banner>
      <Banner
        tone="danger"
        action={
          <Button size="sm" variant="secondary">
            End session
          </Button>
        }
      >
        Support access by Platform Support · read-only · ends 14:32 · actions are logged
      </Banner>
    </div>
  ),
};

export const Badges: StoryObj = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <StatusBadge status="draft">Draft</StatusBadge>
      <StatusBadge status="review">In review</StatusBadge>
      <StatusBadge status="published">Published</StatusBadge>
      <StatusBadge status="pending">Pending</StatusBadge>
      <StatusBadge status="paid">Paid</StatusBadge>
      <StatusBadge status="failed">Failed</StatusBadge>
      <StatusBadge status="attention">Needs review</StatusBadge>
    </div>
  ),
};

export const SaveStates: StoryObj = {
  render: () => (
    <div className="flex flex-col gap-2">
      <SaveIndicator state="saving" label="Saving…" />
      <SaveIndicator state="saved" label="Saved · 2 s ago" />
      <SaveIndicator state="offline" label="Offline — will sync" />
      <SaveIndicator state="error" label="Couldn't save" retryLabel="Retry" onRetry={() => undefined} />
    </div>
  ),
};

export const Skeletons: StoryObj = {
  render: () => (
    <div className="flex max-w-sm flex-col gap-2">
      <Skeleton className="h-40" delayMs={0} />
      <Skeleton className="h-5 w-2/3" delayMs={0} />
      <Skeleton className="h-5 w-1/3" delayMs={0} />
    </div>
  ),
};

export const DataDisplay: StoryObj = {
  render: () => (
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="grid gap-4 md:grid-cols-3">
        <StatCard
          label="Revenue (30 days)"
          value={<Money amountMinor={1_254_000} currency="ZMW" locale="en-ZM" />}
        />
        <StatCard label="New learners" value="148" detail="+12% on the previous 30 days" />
        <StatCard label="Payment success" value="96.4%" />
      </div>
      <Card>
        <p className="text-h3">Biology: Cell structure</p>
        <p className="text-body-sm text-muted">
          <Money amountMinor={25_000} currency="ZMW" locale="en-ZM" /> ·{' '}
          <Money amountMinor={0} currency="ZMW" locale="en-ZM" freeLabel="Free" /> preview
        </p>
        <ProgressLine className="mt-4" value={6} max={14} label="6 of 14 lessons" />
      </Card>
      <Stepper
        label="Checkout progress"
        steps={['Order', 'Pay', 'Confirm']}
        current={1}
        completedLabel="completed"
      />
    </div>
  ),
};

export const TabsAndNav: StoryObj = {
  render: () => (
    <div className="flex flex-col gap-8">
      <Tabs
        label="Course sections"
        items={[
          { value: 'outline', label: 'Outline', content: <p>Sections and lessons.</p> },
          { value: 'details', label: 'Details', content: <p>Title, subtitle and description.</p> },
          { value: 'pricing', label: 'Pricing', content: <p>Price and access.</p> },
        ]}
      />
      <SecondaryNav
        label="Course workspace"
        items={[
          { href: '#outline', label: 'Outline', current: true },
          { href: '#questions', label: 'Questions' },
          { href: '#quizzes', label: 'Quizzes' },
          { href: '#publish', label: 'Publish' },
        ]}
      />
    </div>
  ),
};

export const ConfirmDialog: StoryObj = {
  render: () => (
    <Dialog
      defaultOpen
      title="Delete lesson 'Cell membranes'?"
      description="Learners lose access to this lesson. This can't be undone."
      closeLabel="Close"
      footer={
        <>
          <Button variant="secondary">Cancel</Button>
          <Button variant="danger">Delete lesson</Button>
        </>
      }
    />
  ),
};

export const SideSheet: StoryObj = {
  render: () => (
    <Sheet
      defaultOpen
      title="Filters"
      closeLabel="Close"
      footer={<Button variant="primary">Show 24 results</Button>}
    >
      <p className="text-body">Subject, level, price, language and length filters go here.</p>
    </Sheet>
  ),
};

function ShowToast() {
  const toast = useToast();
  useEffect(() => {
    toast({
      title: 'Lesson moved',
      description: 'Cell membranes is now lesson 3.',
      action: { label: 'Undo', altText: 'Undo the move', onAction: () => undefined },
    });
  }, [toast]);
  return <p className="text-body text-muted">A toast appears in the corner.</p>;
}

export const Toasts: StoryObj = {
  render: () => (
    <ToastProvider closeLabel="Dismiss" regionLabel="Notifications ({hotkey})">
      <ShowToast />
    </ToastProvider>
  ),
};
