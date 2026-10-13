import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  BookOpen,
  Building2,
  ChartColumn,
  Compass,
  CreditCard,
  House,
  LayoutDashboard,
  Library,
  Palette,
  Settings,
  UserRound,
  Users,
} from 'lucide-react';

import { Button } from './button.js';
import { Card, StatCard } from './data-display.js';
import { Banner } from './feedback.js';
import { LearnShell, PublicShell } from './shells.js';
import { StatePanel } from './states.js';
import { WorkspaceShell } from './workspace-shell.js';

const meta: Meta = { title: 'Shells', parameters: { layout: 'fullscreen' } };
export default meta;

const icon = 'size-5 shrink-0';
const brand = { name: 'Acme Academy', href: '#' };

const footer = (
  <div className="flex flex-wrap gap-x-6 gap-y-2">
    <a href="#help">Help</a>
    <a href="#terms">Terms</a>
    <a href="#privacy">Privacy</a>
    <a href="#refunds">Refund policy</a>
    <span className="ms-auto">Powered by StudyHub</span>
  </div>
);

export const Public: StoryObj = {
  render: () => (
    <PublicShell
      brand={brand}
      navLabel="Main"
      skipLabel="Skip to content"
      nav={[
        { href: '#browse', label: 'Browse', current: true },
        { href: '#teach', label: 'Become a tutor' },
      ]}
      actions={
        <>
          <Button variant="ghost" size="sm">
            Sign in
          </Button>
          <Button variant="primary" size="sm">
            Create account
          </Button>
        </>
      }
      footer={footer}
    >
      <h1 className="text-display">What do you want to learn?</h1>
      <p className="mt-2 max-w-reading text-body-lg text-muted">Courses and practice from Acme Academy.</p>
    </PublicShell>
  ),
};

const learnNav = [
  { href: '#home', label: 'Home', icon: <House aria-hidden="true" className={icon} />, current: true },
  { href: '#browse', label: 'Browse', icon: <Compass aria-hidden="true" className={icon} /> },
  { href: '#learning', label: 'Learning', icon: <BookOpen aria-hidden="true" className={icon} /> },
  { href: '#account', label: 'Account', icon: <UserRound aria-hidden="true" className={icon} /> },
];

export const Learn: StoryObj = {
  render: () => (
    <LearnShell brand={brand} nav={learnNav} navLabel="Main" skipLabel="Skip to content">
      <h1 className="text-h1">My learning</h1>
      <StatePanel
        kind="empty"
        title="You haven't enrolled in a course yet"
        message="Courses you enrol in appear here."
        actions={<Button variant="primary">Browse courses</Button>}
      />
    </LearnShell>
  ),
};

export const LearnOffline: StoryObj = {
  render: () => (
    <LearnShell
      brand={brand}
      nav={learnNav}
      navLabel="Main"
      skipLabel="Skip to content"
      banner={<Banner tone="warning">You're offline. We'll sync when you're back.</Banner>}
    >
      <h1 className="text-h1">My learning</h1>
    </LearnShell>
  ),
};

export const Studio: StoryObj = {
  render: () => (
    <WorkspaceShell
      variant="studio"
      brand={brand}
      navLabel="Studio"
      skipLabel="Skip to content"
      menuLabel="Menu"
      closeLabel="Close"
      title="Courses"
      breadcrumbLabel="Breadcrumb"
      breadcrumbs={[
        { href: '#studio', label: 'Studio' },
        { href: '#courses', label: 'Courses' },
      ]}
      headerActions={<Button variant="primary">New course</Button>}
      nav={[
        {
          href: '#courses',
          label: 'Courses',
          icon: <Library aria-hidden="true" className={icon} />,
          current: true,
        },
        { href: '#results', label: 'Results', icon: <ChartColumn aria-hidden="true" className={icon} /> },
        { href: '#earnings', label: 'Earnings', icon: <CreditCard aria-hidden="true" className={icon} /> },
        { href: '#profile', label: 'Profile', icon: <UserRound aria-hidden="true" className={icon} /> },
      ]}
    >
      <StatePanel
        kind="empty"
        title="No courses yet"
        message="Start with an outline: sections first, lessons second."
        actions={<Button variant="secondary">Read the guide</Button>}
      />
    </WorkspaceShell>
  ),
};

const adminNav = [
  {
    href: '#overview',
    label: 'Overview',
    icon: <LayoutDashboard aria-hidden="true" className={icon} />,
    current: true,
  },
  { href: '#users', label: 'Users', icon: <Users aria-hidden="true" className={icon} /> },
  { href: '#branding', label: 'Branding', icon: <Palette aria-hidden="true" className={icon} /> },
  { href: '#settings', label: 'Settings', icon: <Settings aria-hidden="true" className={icon} /> },
];

export const Admin: StoryObj = {
  render: () => (
    <WorkspaceShell
      variant="admin"
      brand={brand}
      navLabel="Administration"
      skipLabel="Skip to content"
      menuLabel="Menu"
      closeLabel="Close"
      title="Overview"
      breadcrumbLabel="Breadcrumb"
      nav={adminNav}
    >
      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label="Tutor applications" value="3" detail="Oldest 2 days" />
        <StatCard label="Course reviews" value="1" detail="Oldest 5 hours" />
        <StatCard label="Payment exceptions" value="0" />
      </div>
      <Card>
        <p className="text-body text-muted">Key metrics appear here once you have sales.</p>
      </Card>
    </WorkspaceShell>
  ),
};

export const Console: StoryObj = {
  parameters: { console: true },
  render: () => (
    <WorkspaceShell
      variant="console"
      realmLabel="Platform console"
      brand={{ name: 'StudyHub', href: '#' }}
      navLabel="Console"
      skipLabel="Skip to content"
      menuLabel="Menu"
      closeLabel="Close"
      title="Tenants"
      breadcrumbLabel="Breadcrumb"
      nav={[
        {
          href: '#overview',
          label: 'Overview',
          icon: <LayoutDashboard aria-hidden="true" className={icon} />,
        },
        {
          href: '#tenants',
          label: 'Tenants',
          icon: <Building2 aria-hidden="true" className={icon} />,
          current: true,
        },
        { href: '#settings', label: 'Settings', icon: <Settings aria-hidden="true" className={icon} /> },
      ]}
    >
      <StatePanel kind="empty" title="No tenants yet" message="Create the first school to get started." />
    </WorkspaceShell>
  ),
};

export const SystemStates: StoryObj = {
  render: () => (
    <div className="flex flex-col divide-y divide-line">
      <StatePanel
        kind="not-found"
        title="We can't find that page"
        message="Check the address, or search the catalogue."
        actions={<Button variant="secondary">Go to home</Button>}
      />
      <StatePanel
        kind="error"
        title="Something went wrong on our side"
        message="Try again in a moment."
        actions={<Button variant="primary">Try again</Button>}
        details={{ summary: 'Details', content: 'Request ID 01J9Z8K4M2' }}
      />
      <StatePanel
        kind="permission"
        title="You don't have access to this page"
        message="Ask your school administrator for access."
      />
      <StatePanel
        kind="offline"
        title="You're offline"
        message="This page will load when you're back online."
      />
      <StatePanel kind="maintenance" title="We're making improvements" message="We'll be back shortly." />
      <StatePanel kind="unavailable" title="This site is temporarily unavailable" />
      <StatePanel kind="coming-soon" title="Coming soon" message="Acme Academy is getting ready." />
    </div>
  ),
};
