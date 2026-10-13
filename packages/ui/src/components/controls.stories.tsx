import type { Meta, StoryObj } from '@storybook/react-vite';
import { Plus } from 'lucide-react';

import { Button } from './button.js';
import { Checkbox, RadioGroup, Switch } from './choice.js';
import { ErrorSummary, TextArea, TextField } from './field.js';
import { Select } from './select.js';

const meta: Meta = { title: 'Controls' };
export default meta;

export const Buttons: StoryObj = {
  render: () => (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <Button variant="primary">Enrol for free</Button>
        <Button variant="secondary">Preview lessons</Button>
        <Button variant="ghost">Cancel</Button>
        <Button variant="danger">Delete lesson</Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" icon={<Plus aria-hidden="true" className="size-4" />}>
          Add section
        </Button>
        <Button variant="secondary" size="sm">
          Export
        </Button>
        <Button variant="primary" loading loadingLabel="Saving…">
          Save
        </Button>
        <Button variant="primary" disabled>
          Publish
        </Button>
      </div>
    </div>
  ),
};

export const TextFields: StoryObj = {
  render: () => (
    <form className="flex max-w-md flex-col gap-4" onSubmit={(event) => event.preventDefault()}>
      <TextField label="Full name" autoComplete="name" required requiredLabel="required" />
      <TextField
        label="Email"
        type="email"
        autoComplete="email"
        hint="We send your receipts here."
        defaultValue="learner@example"
        error="Enter an email address like name@example.com"
      />
      <TextField label="Mobile number" type="tel" autoComplete="tel" hint="For example 097 123 4567" />
      <TextArea label="Course description" hint="Two or three sentences." />
      <TextField label="School code" disabled defaultValue="ACME" />
    </form>
  ),
};

export const FormErrorSummary: StoryObj = {
  render: () => (
    <div className="flex max-w-md flex-col gap-4">
      <ErrorSummary
        title="There are 2 problems with this form"
        errors={[
          { fieldId: 'summary-email', message: 'Enter an email address like name@example.com' },
          { fieldId: 'summary-password', message: 'Use at least 12 characters for your password' },
        ]}
      />
      <TextField id="summary-email" label="Email" error="Enter an email address like name@example.com" />
      <TextField
        id="summary-password"
        label="Password"
        type="password"
        error="Use at least 12 characters for your password"
      />
    </div>
  ),
};

export const Choices: StoryObj = {
  render: () => (
    <div className="flex max-w-md flex-col gap-6">
      <div>
        <Checkbox label="I agree to the terms and the privacy notice" />
        <Checkbox label="Email me about new courses" hint="At most one email a week." defaultChecked />
        <Checkbox label="Downloads allowed" disabled />
      </div>
      <RadioGroup
        legend="Level"
        defaultValue="beginner"
        options={[
          { value: 'beginner', label: 'Beginner' },
          { value: 'intermediate', label: 'Intermediate' },
          { value: 'advanced', label: 'Advanced' },
        ]}
      />
      <div>
        <Switch
          label="Practice mode"
          description="Learners can practise with unlimited questions."
          defaultChecked
        />
        <Switch label="Data saver" description="Videos start at 360p." />
      </div>
    </div>
  ),
};

export const Selects: StoryObj = {
  render: () => (
    <div className="flex max-w-md flex-col gap-4">
      <Select
        label="Language"
        defaultValue="en"
        options={[
          { value: 'en', label: 'English' },
          { value: 'bem', label: 'Bemba (coming soon)', disabled: true },
        ]}
      />
      <Select
        label="Sort by"
        placeholder="Choose an order"
        hint="Applies to the results below."
        options={[
          { value: 'relevance', label: 'Relevance' },
          { value: 'newest', label: 'Newest' },
          { value: 'price', label: 'Price: low to high' },
        ]}
      />
    </div>
  ),
};
