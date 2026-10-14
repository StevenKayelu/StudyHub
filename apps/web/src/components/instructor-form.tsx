'use client';

import type { InstructorProfileView } from '@studyhub/contracts';
import { Alert, Button, TextArea, TextField } from '@studyhub/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { callApi } from '../lib/client-api';
import { fill } from '../lib/fill';
import { type FormTexts, text, useApiForm } from './forms';

export interface InstructorFormTexts extends FormTexts {
  displayName: string;
  headline: string;
  headlineHint: string;
  bio: string;
  subjects: string;
  subjectsHint: string;
  qualifications: string;
  saveDraft: string;
  save: string;
  saved: string;
  submit: string;
  submitting: string;
  status: Record<string, string>;
  reapplyAfter: string;
}

/**
 * Instructor application (S-T01, F06) and, for approved instructors, the profile editor (S-T12). The
 * same fields either way; only applicants see "Submit application".
 */
export function InstructorForm({
  profile,
  defaultName,
  mode,
  texts,
}: {
  profile: InstructorProfileView | null;
  defaultName: string;
  mode: 'apply' | 'profile';
  texts: InstructorFormTexts;
}) {
  const router = useRouter();
  const form = useApiForm(texts);
  const [savedAt, setSavedAt] = useState(false);
  const editable =
    mode === 'profile' ||
    profile === null ||
    ['DRAFT', 'CHANGES_REQUESTED', 'REJECTED'].includes(profile.status);
  const waiting =
    profile?.status === 'REJECTED' &&
    profile.reapplyAfter !== null &&
    new Date(profile.reapplyAfter) > new Date();

  const body = (data: FormData) => ({
    displayName: text(data, 'displayName'),
    headline: text(data, 'headline') || undefined,
    bio: text(data, 'bio') || undefined,
    subjects: text(data, 'subjects')
      .split(',')
      .map((subject) => subject.trim())
      .filter((subject) => subject !== '')
      .slice(0, 10),
    qualifications: text(data, 'qualifications') || undefined,
  });

  return (
    <form
      className="flex max-w-reading flex-col gap-4"
      noValidate
      onSubmit={async (event) => {
        const intent = ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value;
        setSavedAt(false);
        const saved = await form.submit(event, async (data) => {
          const result = await callApi<InstructorProfileView>('PUT', '/api/v1/me/instructor', body(data));
          if (!result.ok || intent !== 'submit') return result;
          return callApi<InstructorProfileView>('POST', '/api/v1/me/instructor/submit');
        });
        if (saved !== null) {
          setSavedAt(true);
          router.refresh();
        }
      }}
    >
      {profile !== null && mode === 'apply' ? (
        <Alert
          tone={
            profile.status === 'REJECTED' ? 'warning' : profile.status === 'APPROVED' ? 'success' : 'info'
          }
          title={texts.status[profile.status]}
        >
          {profile.decisionNote ?? null}
          {waiting && profile.reapplyAfter !== null ? (
            <p>{fill(texts.reapplyAfter, { date: new Date(profile.reapplyAfter).toLocaleDateString() })}</p>
          ) : null}
        </Alert>
      ) : null}
      {form.feedback}
      {savedAt ? <Alert tone="success" role="status" title={texts.saved} /> : null}
      <fieldset disabled={!editable || form.busy} className="flex flex-col gap-4">
        <TextField
          id="displayName"
          name="displayName"
          label={texts.displayName}
          defaultValue={profile?.displayName ?? defaultName}
          maxLength={120}
          required
          error={form.fieldError('displayName')}
        />
        <TextField
          id="headline"
          name="headline"
          label={texts.headline}
          hint={texts.headlineHint}
          defaultValue={profile?.headline ?? ''}
          maxLength={120}
          error={form.fieldError('headline')}
        />
        <TextArea
          id="bio"
          name="bio"
          label={texts.bio}
          defaultValue={profile?.bio ?? ''}
          maxLength={4000}
          rows={6}
          error={form.fieldError('bio')}
        />
        <TextField
          id="subjects"
          name="subjects"
          label={texts.subjects}
          hint={texts.subjectsHint}
          defaultValue={profile?.subjects.join(', ') ?? ''}
          error={form.fieldError('subjects')}
        />
        {mode === 'apply' ? (
          <TextArea
            id="qualifications"
            name="qualifications"
            label={texts.qualifications}
            defaultValue={profile?.qualifications ?? ''}
            maxLength={2000}
            rows={4}
            error={form.fieldError('qualifications')}
          />
        ) : null}
        <div className="flex flex-wrap gap-2">
          {mode === 'apply' ? (
            <>
              <Button type="submit" name="intent" value="submit" variant="primary" disabled={waiting}>
                {form.busy ? texts.submitting : texts.submit}
              </Button>
              <Button type="submit" name="intent" value="draft" variant="secondary">
                {texts.saveDraft}
              </Button>
            </>
          ) : (
            <Button type="submit" name="intent" value="save" variant="primary">
              {texts.save}
            </Button>
          )}
        </div>
      </fieldset>
    </form>
  );
}
