'use client';

import {
  type BrandingDraft,
  type BrandingEditor as BrandingEditorData,
  HOME_SECTION_KEYS,
  SOCIAL_KEYS,
  type ValidateColourResponse,
} from '@studyhub/contracts';
import { Alert, Button, Card, Checkbox, Dialog, Select, StatusBadge, TextField } from '@studyhub/ui';
import { ArrowDown, ArrowUp, Trash2, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';

import { callApi } from '../lib/client-api';
import { fill } from '../lib/fill';
import { type UploadPhase, uploadFile } from '../lib/upload';
import { type FormTexts, useApiForm } from './forms';

type Strings = Record<string, string>;

export interface BrandingTexts extends FormTexts {
  b: Strings & { fonts: Strings; sectionNames: Strings; termNames: Strings };
  upload: Strings;
  close: string;
  cancel: string;
  /** Pre-formatted "Version n · date" and "by name" lines, keyed by version. */
  versionLines: Record<number, string>;
}

type ImageKey = 'logoAssetId' | 'logoDarkAssetId' | 'faviconAssetId' | 'appIconAssetId';
const IMAGES: { key: ImageKey; label: string }[] = [
  { key: 'logoAssetId', label: 'logo' },
  { key: 'logoDarkAssetId', label: 'logoDark' },
  { key: 'faviconAssetId', label: 'favicon' },
  { key: 'appIconAssetId', label: 'appIcon' },
];
const TERMS = ['instructor', 'instructors', 'course', 'courses'] as const;

/** White or near-black, whichever reads better on the accent (WCAG relative luminance). */
function textOn(hex: string): string {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return 1.05 / (luminance + 0.05) >= 4.5 ? '#ffffff' : '#1c1917';
}

/**
 * S-AD12 Branding (F39, UX-14): edit a draft, check the accent colour against BR-51 with the theme
 * compiler, preview, publish; earlier versions can be restored. Texts are edited in the default
 * locale (only English ships, BR-61); other locales' values are kept as they are.
 */
export function BrandingEditor({
  initial,
  locale,
  texts,
}: {
  initial: BrandingEditorData;
  locale: string;
  texts: BrandingTexts;
}) {
  const router = useRouter();
  const b = texts.b;
  const form = useApiForm(texts);
  const [draft, setDraft] = useState<BrandingDraft>(initial.draft);
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>(initial.assetUrls);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [colour, setColour] = useState(initial.draft.accentHex ?? '');
  const [checks, setChecks] = useState<ValidateColourResponse | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionProblem, setActionProblem] = useState<string | null>(null);

  const update = (patch: Partial<BrandingDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
    setSaved(false);
  };
  const localized = (value: Record<string, string> | null | undefined) => value?.[locale] ?? '';
  const withLocale = (value: Record<string, string> | null | undefined, text: string) => {
    const next = { ...value };
    if (text.trim() === '') delete next[locale];
    else next[locale] = text;
    return Object.keys(next).length === 0 ? undefined : next;
  };

  async function save(): Promise<boolean> {
    const result = await callApi('PUT', '/api/v1/admin/branding/draft', {
      ...draft,
      accentHex: colour.trim() === '' ? null : colour.trim(),
    });
    if (!result.ok) {
      form.setSummary(result.problem.detail ?? result.problem.title ?? texts.networkError);
      return false;
    }
    setDirty(false);
    setSaved(true);
    router.refresh();
    return true;
  }

  async function check(hex: string): Promise<void> {
    setColour(hex);
    setDirty(true);
    const result = await callApi<ValidateColourResponse>('POST', '/api/v1/admin/branding/validate-colour', {
      accentHex: hex,
    });
    setChecks(result.ok ? result.data : null);
  }

  async function act(path: string): Promise<void> {
    setBusy(true);
    setActionProblem(null);
    if (dirty && !(await save())) {
      setBusy(false);
      return;
    }
    const result = await callApi('POST', path);
    setBusy(false);
    if (!result.ok) {
      setActionProblem(result.problem.detail ?? result.problem.title);
      return;
    }
    setPublishOpen(false);
    setRestoring(null);
    // The theme stylesheet and icons are cached per version: a full reload picks up the new ones.
    window.location.reload();
  }

  const sections =
    draft.homeLayout.sections.length > 0
      ? draft.homeLayout.sections
      : HOME_SECTION_KEYS.map((key) => ({ key, visible: true }));
  const moveSection = (index: number, by: -1 | 1) => {
    const next = [...sections];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item!);
    update({ homeLayout: { ...draft.homeLayout, sections: next } });
  };
  const accent = /^#[0-9a-fA-F]{6}$/.test(colour) ? (checks?.adjusted ?? colour) : '#b4532a';

  return (
    <div className="flex flex-col gap-6" data-testid="branding-editor">
      {form.feedback}
      {initial.hasUnpublishedChanges || dirty ? <Alert tone="info" title={b.unpublished!} /> : null}
      <div className="grid gap-6 xl:grid-cols-[1fr_20rem]">
        <div className="flex flex-col gap-6">
          <Card>
            <h2 className="text-h3">{b.identity}</h2>
            <div className="mt-3 flex flex-col gap-4">
              <TextField
                id="displayName"
                label={b.displayName}
                value={draft.displayName}
                onChange={(e) => update({ displayName: e.target.value })}
                required
              />
              {IMAGES.map(({ key, label }) => (
                <ImageField
                  key={key}
                  label={b[label]!}
                  hint={b.imageHint!}
                  url={draft[key] === null ? null : (assetUrls[draft[key]] ?? null)}
                  texts={texts}
                  testId={`upload-${label}`}
                  onReady={(assetId, previewUrl) => {
                    if (previewUrl !== null) setAssetUrls((u) => ({ ...u, [assetId]: previewUrl }));
                    update({ [key]: assetId } as Partial<BrandingDraft>);
                  }}
                  onRemove={() => update({ [key]: null } as Partial<BrandingDraft>)}
                />
              ))}
            </div>
          </Card>

          <Card>
            <h2 className="text-h3">{b.colour}</h2>
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <input
                type="color"
                aria-hidden="true"
                tabIndex={-1}
                value={/^#[0-9a-fA-F]{6}$/.test(colour) ? colour : '#b4532a'}
                onChange={(e) => void check(e.target.value)}
                className="h-11 w-14 cursor-pointer rounded-md border border-line bg-surface"
              />
              <div className="w-40">
                <TextField
                  id="accentHex"
                  label={b.accent}
                  value={colour}
                  placeholder="#b4532a"
                  onChange={(e) => {
                    setColour(e.target.value);
                    setDirty(true);
                    setChecks(null);
                  }}
                />
              </div>
              <Button
                variant="secondary"
                disabled={!/^#[0-9a-fA-F]{6}$/.test(colour)}
                onClick={() => void check(colour)}
                data-testid="check-colour"
              >
                {b.check}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setColour('');
                  setChecks(null);
                  setDirty(true);
                }}
              >
                {b.useDefault}
              </Button>
            </div>
            {checks !== null ? (
              <div className="mt-4 flex flex-col gap-3" data-testid="contrast-checks" data-ok={checks.ok}>
                {checks.message !== null ? (
                  <Alert tone={checks.ok ? 'info' : 'warning'} title={checks.message} />
                ) : null}
                <h3 className="text-label">{b.checks}</h3>
                <div className="grid gap-3 md:grid-cols-2">
                  {(['light', 'dark'] as const).map((theme) => (
                    <div key={theme}>
                      <p className="text-body-sm text-muted">{b[theme]}</p>
                      <ul className="mt-1 flex flex-col gap-1 text-body-sm">
                        {checks.checks[theme].map((c) => (
                          <li key={c.pair} className="flex items-center justify-between gap-2">
                            <span>{c.pair}</span>
                            <span className="tabular">
                              {c.ratio.toFixed(2)}:1{' '}
                              <StatusBadge status={c.pass ? 'published' : 'failed'}>
                                {c.pass ? b.pass : b.fail}
                              </StatusBadge>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
                {checks.suggestions.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-body-sm">{b.suggestions}</span>
                    {checks.suggestions.map((hex) => (
                      <Button key={hex} size="sm" variant="secondary" onClick={() => void check(hex)}>
                        <span
                          aria-hidden="true"
                          className="size-4 rounded-full border border-line"
                          style={{ backgroundColor: hex }}
                        />
                        {fill(b.useSuggestion!, { colour: hex })}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </Card>

          <Card>
            <h2 className="text-h3">{b.typography}</h2>
            <div className="mt-3 max-w-sm">
              <Select
                id="fontPreset"
                label={b.font}
                value={draft.fontPreset}
                options={Object.entries(b.fonts).map(([value, label]) => ({ value, label }))}
                onValueChange={(value) => update({ fontPreset: value as BrandingDraft['fontPreset'] })}
              />
            </div>
          </Card>

          <Card>
            <h2 className="text-h3">{b.home}</h2>
            <div className="mt-3 flex flex-col gap-4">
              <TextField
                id="heroTitle"
                label={b.heroTitle}
                value={localized(draft.homeLayout.heroTitle)}
                onChange={(e) =>
                  update({
                    homeLayout: {
                      ...draft.homeLayout,
                      heroTitle: withLocale(draft.homeLayout.heroTitle, e.target.value),
                    },
                  })
                }
              />
              <TextField
                id="heroSubtitle"
                label={b.heroSubtitle}
                value={localized(draft.homeLayout.heroSubtitle)}
                onChange={(e) =>
                  update({
                    homeLayout: {
                      ...draft.homeLayout,
                      heroSubtitle: withLocale(draft.homeLayout.heroSubtitle, e.target.value),
                    },
                  })
                }
              />
              <fieldset>
                <legend className="text-label">{b.sections}</legend>
                <ol className="mt-2 flex flex-col divide-y divide-line rounded-md border border-line">
                  {sections.map((section, index) => (
                    <li key={section.key} className="flex flex-wrap items-center justify-between gap-2 p-2">
                      <Checkbox
                        id={`section-${section.key}`}
                        label={b.sectionNames[section.key] ?? section.key}
                        checked={section.visible}
                        onCheckedChange={(visible) => {
                          const next = sections.map((s) => (s.key === section.key ? { ...s, visible } : s));
                          update({ homeLayout: { ...draft.homeLayout, sections: next } });
                        }}
                      />
                      <span className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`${b.up}: ${b.sectionNames[section.key]}`}
                          disabled={index === 0}
                          onClick={() => moveSection(index, -1)}
                        >
                          <ArrowUp aria-hidden="true" className="size-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`${b.down}: ${b.sectionNames[section.key]}`}
                          disabled={index === sections.length - 1}
                          onClick={() => moveSection(index, 1)}
                        >
                          <ArrowDown aria-hidden="true" className="size-4" />
                        </Button>
                      </span>
                    </li>
                  ))}
                </ol>
              </fieldset>
            </div>
          </Card>

          <Card>
            <h2 className="text-h3">{b.footer}</h2>
            <div className="mt-3 flex flex-col gap-4">
              <TextField
                id="supportEmail"
                type="email"
                label={b.supportEmail}
                value={draft.supportEmail ?? ''}
                error={form.fieldError('supportEmail')}
                onChange={(e) =>
                  update({ supportEmail: e.target.value.trim() === '' ? null : e.target.value })
                }
              />
              <TextField
                id="supportPhone"
                type="tel"
                label={b.supportPhone}
                value={draft.supportPhone ?? ''}
                error={form.fieldError('supportPhone')}
                onChange={(e) =>
                  update({ supportPhone: e.target.value.trim() === '' ? null : e.target.value })
                }
              />
              <fieldset className="flex flex-col gap-2">
                <legend className="text-label">{b.footerLinks}</legend>
                {draft.footerLinks.map((link, index) => (
                  <div key={index} className="flex flex-wrap items-end gap-2">
                    <div className="min-w-40 flex-1">
                      <TextField
                        id={`link-label-${index}`}
                        label={b.linkLabel}
                        value={localized(link.label)}
                        onChange={(e) => {
                          const next = [...draft.footerLinks];
                          next[index] = { ...link, label: withLocale(link.label, e.target.value) ?? {} };
                          update({ footerLinks: next });
                        }}
                      />
                    </div>
                    <div className="min-w-48 flex-[2]">
                      <TextField
                        id={`link-url-${index}`}
                        label={b.linkUrl}
                        value={link.url}
                        onChange={(e) => {
                          const next = [...draft.footerLinks];
                          next[index] = { ...link, url: e.target.value };
                          update({ footerLinks: next });
                        }}
                      />
                    </div>
                    <Button
                      variant="ghost"
                      aria-label={b.remove}
                      onClick={() => update({ footerLinks: draft.footerLinks.filter((_, i) => i !== index) })}
                    >
                      <Trash2 aria-hidden="true" className="size-4" />
                    </Button>
                  </div>
                ))}
                {draft.footerLinks.length < 8 ? (
                  <div>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => update({ footerLinks: [...draft.footerLinks, { label: {}, url: '' }] })}
                    >
                      {b.addLink}
                    </Button>
                  </div>
                ) : null}
              </fieldset>
              <fieldset className="grid gap-3 md:grid-cols-2">
                <legend className="mb-2 text-label">{b.social}</legend>
                {SOCIAL_KEYS.map((network) => (
                  <TextField
                    key={network}
                    id={`social-${network}`}
                    type="url"
                    label={<span className="capitalize">{network}</span>}
                    placeholder="https://"
                    value={draft.social[network] ?? ''}
                    onChange={(e) => {
                      const next = { ...draft.social };
                      if (e.target.value.trim() === '') delete next[network];
                      else next[network] = e.target.value;
                      update({ social: next });
                    }}
                  />
                ))}
              </fieldset>
            </div>
          </Card>

          <Card>
            <h2 className="text-h3">{b.terminology}</h2>
            <p className="mt-1 text-body-sm text-muted">{b.terminologyHint}</p>
            <div className="mt-3 grid gap-4 md:grid-cols-2">
              {TERMS.map((term) => (
                <TextField
                  key={term}
                  id={`term-${term}`}
                  label={b.termNames[term] ?? term}
                  value={localized(draft.terminology[term])}
                  onChange={(e) =>
                    update({
                      terminology: {
                        ...draft.terminology,
                        [term]: withLocale(draft.terminology[term], e.target.value),
                      },
                    })
                  }
                />
              ))}
              <TextField
                id="emailFromName"
                label={b.emailSender}
                value={localized(draft.emailFromName)}
                onChange={(e) =>
                  update({ emailFromName: withLocale(draft.emailFromName, e.target.value) ?? null })
                }
              />
            </div>
            <div className="mt-4">
              <Checkbox
                id="showPoweredBy"
                label={b.poweredBy}
                hint={initial.whiteLabelAllowed ? undefined : b.poweredByLocked}
                checked={draft.showPoweredBy}
                disabled={!initial.whiteLabelAllowed}
                onCheckedChange={(checked) => update({ showPoweredBy: checked })}
              />
            </div>
          </Card>
        </div>

        <aside className="flex flex-col gap-4 xl:sticky xl:top-4 xl:self-start">
          <Card>
            <h2 className="text-h3">{b.preview}</h2>
            <div
              className="mt-3 flex flex-col gap-3 rounded-md border border-line bg-canvas p-4"
              data-testid="branding-preview"
            >
              <div className="flex items-center gap-2">
                {draft.logoAssetId !== null && assetUrls[draft.logoAssetId] !== undefined ? (
                  // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
                  <img src={assetUrls[draft.logoAssetId]} alt="" className="h-8 w-auto" />
                ) : null}
                <span className="text-label">{draft.displayName}</span>
              </div>
              <p className="text-h3">{localized(draft.homeLayout.heroTitle) || b.previewHeading}</p>
              <span
                className="inline-flex h-11 items-center self-start rounded-md px-4 text-label"
                style={{ backgroundColor: accent, color: textOn(accent) }}
              >
                {b.previewButton}
              </span>
            </div>
          </Card>
          <Card>
            <div className="flex flex-col gap-2">
              <Button
                variant="secondary"
                loading={form.busy}
                onClick={() => void save()}
                data-testid="save-branding"
              >
                {b.save}
              </Button>
              {saved ? (
                <span role="status" className="text-caption text-muted">
                  {b.saved}
                </span>
              ) : null}
              <Dialog
                open={publishOpen}
                onOpenChange={setPublishOpen}
                trigger={
                  <Button variant="primary" data-testid="publish-branding">
                    {b.publish}
                  </Button>
                }
                title={b.publishTitle!}
                description={b.publishBody}
                closeLabel={texts.close}
                preventClose={busy}
                footer={
                  <>
                    <Button variant="ghost" onClick={() => setPublishOpen(false)} disabled={busy}>
                      {texts.cancel}
                    </Button>
                    <Button
                      variant="primary"
                      loading={busy}
                      onClick={() => void act('/api/v1/admin/branding/publish')}
                      data-testid="publish-branding-confirm"
                    >
                      {b.publish}
                    </Button>
                  </>
                }
              >
                {actionProblem !== null ? <Alert tone="danger" role="alert" title={actionProblem} /> : null}
              </Dialog>
            </div>
          </Card>
          <Card>
            <h2 className="text-h3">{b.versions}</h2>
            <ul className="mt-2 flex flex-col divide-y divide-line">
              {initial.versions.map((v) => (
                <li key={v.version} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="text-body-sm">{texts.versionLines[v.version]}</span>
                  {v.version === initial.publishedVersion ? (
                    <StatusBadge status="published">{b.current}</StatusBadge>
                  ) : (
                    <Dialog
                      open={restoring === v.version}
                      onOpenChange={(open) => setRestoring(open ? v.version : null)}
                      trigger={
                        <Button size="sm" variant="ghost">
                          {b.restore}
                        </Button>
                      }
                      title={fill(b.restoreTitle!, { version: v.version })}
                      description={b.restoreBody}
                      closeLabel={texts.close}
                      preventClose={busy}
                      footer={
                        <>
                          <Button variant="ghost" onClick={() => setRestoring(null)} disabled={busy}>
                            {texts.cancel}
                          </Button>
                          <Button
                            variant="primary"
                            loading={busy}
                            onClick={() => void act(`/api/v1/admin/branding/rollback/${v.version}`)}
                          >
                            {b.restore}
                          </Button>
                        </>
                      }
                    >
                      {actionProblem !== null ? (
                        <Alert tone="danger" role="alert" title={actionProblem} />
                      ) : null}
                    </Dialog>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </aside>
      </div>
    </div>
  );
}

/** One logo or icon: current image, upload through the media pipeline (BRANDING), remove. */
function ImageField({
  label,
  hint,
  url,
  texts,
  testId,
  onReady,
  onRemove,
}: {
  label: string;
  hint: string;
  url: string | null;
  texts: BrandingTexts;
  testId: string;
  onReady: (assetId: string, previewUrl: string | null) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const [phase, setPhase] = useState<UploadPhase | null>(null);
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<string | null>(null);
  const working = phase === 'uploading' || phase === 'checking';
  const status =
    phase === null
      ? null
      : phase === 'rejected'
        ? fill(texts.upload.rejected!, { reason: detail ?? '' })
        : phase === 'failed'
          ? (detail ?? texts.upload.failed)
          : texts.upload[phase];
  const shown = preview ?? url;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-label">{label}</span>
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex size-14 items-center justify-center overflow-hidden rounded-md border border-line bg-sunken">
          {shown !== null ? (
            // eslint-disable-next-line @next/next/no-img-element -- local preview or short-lived signed URL
            <img src={shown} alt="" className="max-h-full max-w-full object-contain" />
          ) : null}
        </span>
        <label
          htmlFor={id}
          className={`inline-flex h-11 items-center gap-2 rounded-md border border-line px-3 text-label ${
            working ? 'pointer-events-none opacity-50' : 'cursor-pointer hover:bg-sunken'
          }`}
        >
          <Upload aria-hidden="true" className="size-4" />
          {texts.b.upload}
        </label>
        <input
          id={id}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="sr-only"
          data-testid={testId}
          disabled={working}
          aria-describedby={`${id}-hint`}
          onChange={async (event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file === undefined) return;
            const local = URL.createObjectURL(file);
            const asset = await uploadFile(file, 'BRANDING', (next, info) => {
              setPhase(next);
              setDetail(info);
            });
            if (asset?.status === 'READY') {
              setPreview(local);
              onReady(asset.id, local);
            }
          }}
        />
        {shown !== null ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setPreview(null);
              setPhase(null);
              onRemove();
            }}
          >
            {texts.b.remove}
          </Button>
        ) : null}
        {status !== null ? (
          <span role="status" aria-live="polite" className="text-body-sm">
            {status}
          </span>
        ) : null}
      </div>
      <p id={`${id}-hint`} className="text-body-sm text-muted">
        {hint}
      </p>
    </div>
  );
}
