'use client';

import type { StudioCourse } from '@studyhub/contracts';
import { Button, TextField } from '@studyhub/ui';

import { callApi, reloadTo } from '../lib/client-api';
import type { StudioTexts } from '../lib/studio-texts-type';
import { text, useApiForm } from './forms';

/** S-T02 New course: a title is enough to start; everything else is filled in the workspace. */
export function NewCourseForm({ texts }: { texts: StudioTexts }) {
  const form = useApiForm(texts.common);
  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      onSubmit={async (event) => {
        const created = await form.submit(event, (data) =>
          callApi<StudioCourse>('POST', '/api/v1/studio/courses', { title: text(data, 'title') }),
        );
        if (created !== null) reloadTo(`/studio/courses/${created.id}`);
      }}
    >
      {form.feedback}
      <div className="flex flex-col gap-3 md:flex-row md:items-end">
        <div className="flex-1">
          <TextField
            id="title"
            name="title"
            label={texts.studio.courseTitle}
            maxLength={120}
            required
            error={form.fieldError('title')}
          />
        </div>
        <Button type="submit" variant="primary" disabled={form.busy}>
          {form.busy ? texts.studio.creating : texts.studio.create}
        </Button>
      </div>
    </form>
  );
}
